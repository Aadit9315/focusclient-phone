const SUPABASE_URL =
    "https://rwyvjlwwjygrqvaiyobj.supabase.co";

const SUPABASE_PUBLISHABLE_KEY =
    "sb_publishable_LGLdZYFCV-K6x5ltCmsmyA_n839DQ_T";

const SAFETY_WINDOW_SECONDS = 120;

const db =
    supabase.createClient(
        SUPABASE_URL,
        SUPABASE_PUBLISHABLE_KEY,
        {
            auth:{
                persistSession:true,
                autoRefreshToken:true,
                detectSessionInUrl:false
            }
        }
    );

let selectedMinutes = 60;
let customDuration = false;
let scheduledStart = false;
let currentBlock = null;
let primaryRealtimeChannel = null;
let emergencyCooldownUntil = 0;
let lastNotificationState = {};
let renderLock = false;

const DEVICE_ID_KEY =
    "focusclient_device_id";

const APP_VERSION =
    "2026.10.02-phone.2";

const $ =
    id =>
        document.getElementById(id);

const ALLOWED_APPLICATIONS = [
    {
        applicationKey:"",
        displayName:"Microsoft Word",
        executablePath:
            "C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE",
        processName:"WINWORD"
    },
    {
        applicationKey:"",
        displayName:"Windows Settings",
        executablePath:
            "C:\\Windows\\ImmersiveControlPanel\\SystemSettings.exe",
        processName:"SystemSettings"
    },
    {
        applicationKey:"",
        displayName:"File Explorer",
        executablePath:
            "C:\\Windows\\Explorer.EXE",
        processName:"explorer"
    }
];

function getDeviceId(){
    let id =
        localStorage.getItem(
            DEVICE_ID_KEY
        );

    if(!id){
        id =
            crypto.randomUUID();

        localStorage.setItem(
            DEVICE_ID_KEY,
            id
        );
    }

    return id;
}

function getDeviceName(){
    const userAgent =
        navigator.userAgent;

    if(
        userAgent.includes("iPhone")
    ){
        return "iPhone";
    }

    if(
        userAgent.includes("iPad")
    ){
        return "iPad";
    }

    if(
        userAgent.includes("Android")
    ){
        return "Android Phone";
    }

    return "FocusClient Phone";
}

function getDevicePlatform(){
    const userAgent =
        navigator.userAgent;

    if(
        userAgent.includes("iPhone") ||
        userAgent.includes("iPad")
    ){
        return "ios";
    }

    if(
        userAgent.includes("Android")
    ){
        return "android";
    }

    return "web";
}

async function registerPrimaryDevice(){
    const deviceId =
        getDeviceId();

    const deviceName =
        getDeviceName();

    const platform =
        getDevicePlatform();

    const {
        data:sessionData,
        error:sessionError
    } =
        await db.auth.getSession();

    if(sessionError){
        throw new Error(
            `Session check failed: ${sessionError.message}`
        );
    }

    if(!sessionData.session){
        throw new Error(
            "No active Supabase session on this device."
        );
    }

    const {
        data,
        error
    } =
        await db.rpc(
            "register_primary_device",
            {
                p_device_id:
                    deviceId,

                p_device_name:
                    deviceName,

                p_platform:
                    platform
            }
        );

    if(error){
        throw new Error(
            `Primary device registration failed: ${error.message}`
        );
    }

    if(!data){
        throw new Error(
            "Primary device registration returned no device."
        );
    }

    return data;
}

function sendNative(message){
    /*
     * The phone normally has no WebView2 bridge.
     * This remains here only so the same UI code does
     * not break if it is ever opened inside WebView2.
     */
    if(
        window.chrome &&
        window.chrome.webview
    ){
        try{
            window.chrome.webview.postMessage(
                JSON.stringify(message)
            );
        }
        catch(error){
            console.warn(
                "Native bridge error:",
                error
            );
        }
    }
}

function setStatus(
    text,
    online
){
    const element =
        $("status");

    if(!element)
        return;

    element.textContent =
        text;

    element.className =
        `status ${
            online
                ?"online"
                :"offline"
        }`;
}

function showApp(){
    const auth =
        $("authView");

    const app =
        $("appView");

    if(auth)
        auth.hidden = true;

    if(app)
        app.hidden = false;
}

function showLogin(){
    const auth =
        $("authView");

    const app =
        $("appView");

    if(auth)
        auth.hidden = false;

    if(app)
        app.hidden = true;
}

function formatRemaining(
    milliseconds
){
    const total =
        Math.max(
            0,
            Math.floor(
                milliseconds / 1000
            )
        );

    const hours =
        Math.floor(
            total / 3600
        );

    const minutes =
        Math.floor(
            (total % 3600) / 60
        );

    const seconds =
        total % 60;

    return (
        `${String(hours).padStart(2,"0")}:` +
        `${String(minutes).padStart(2,"0")}:` +
        `${String(seconds).padStart(2,"0")}`
    );
}

function formatShortRemaining(
    milliseconds
){
    const seconds =
        Math.max(
            0,
            Math.ceil(
                milliseconds / 1000
            )
        );

    if(seconds >= 60){
        const minutes =
            Math.floor(
                seconds / 60
            );

        const remaining =
            seconds % 60;

        return (
            `${minutes}m ` +
            `${String(remaining).padStart(2,"0")}s`
        );
    }

    return `${seconds}s`;
}

function normalizeBlock(
    block
){
    if(!block)
        return null;

    return {
        id:
            block.id ??
            block.blockId ??
            null,

        user_id:
            block.user_id ??
            null,

        name:
            block.name ??
            "Focus Session",

        description:
            block.description ??
            "",

        version:
            Number(
                block.version ??
                1
            ),

        starts_at:
            block.starts_at ??
            block.startsAt ??
            block.StartsAtUtc ??
            null,

        ends_at:
            block.ends_at ??
            block.endsAt ??
            block.EndsAtUtc ??
            null,

        settings:
            block.settings ??
            {},

        schedule:
            block.schedule ??
            {},

        extensions:
            block.extensions ??
            {}
    };
}

/*
 * The Windows engine treats:
 *
 * starts_at + SAFETY_WINDOW_SECONDS
 *
 * as the actual enforcement/focus start.
 *
 * Therefore the phone stores:
 *
 * scheduled focus:
 *     starts_at = scheduledFocusStart - 2 minutes
 *
 * start now:
 *     starts_at = now
 *
 * ends_at is ALWAYS:
 *
 *     actualFocusStart + requestedDuration
 *
 * This means the requested duration is never consumed
 * by the safety window.
 */
function getActualFocusStart(
    block = currentBlock
){
    if(!block)
        return 0;

    if(
        block.extensions &&
        block.extensions.focusStartAtUtc
    ){
        const explicit =
            new Date(
                block.extensions.focusStartAtUtc
            ).getTime();

        if(
            Number.isFinite(
                explicit
            )
        ){
            return explicit;
        }
    }

    if(!block.starts_at)
        return 0;

    return (
        new Date(
            block.starts_at
        ).getTime() +
        SAFETY_WINDOW_SECONDS * 1000
    );
}

function getWarningStart(
    block = currentBlock
){
    if(!block?.starts_at)
        return 0;

    return new Date(
        block.starts_at
    ).getTime();
}

function getEnd(
    block = currentBlock
){
    if(!block?.ends_at)
        return 0;

    return new Date(
        block.ends_at
    ).getTime();
}

function isInsideBlockWindow(
    block,
    now = Date.now()
){
    if(!block)
        return false;

    const start =
        getWarningStart(
            block
        );

    const end =
        getEnd(
            block
        );

    if(
        !Number.isFinite(start) ||
        !Number.isFinite(end)
    ){
        return false;
    }

    return (
        now >= start &&
        now < end
    );
}

function isInSafetyWindow(
    block,
    now = Date.now()
){
    if(
        !isInsideBlockWindow(
            block,
            now
        )
    ){
        return false;
    }

    return (
        now <
        getActualFocusStart(
            block
        )
    );
}

function isFocusActive(
    block,
    now = Date.now()
){
    if(
        !isInsideBlockWindow(
            block,
            now
        )
    ){
        return false;
    }

    return (
        now >=
        getActualFocusStart(
            block
        )
    );
}

function renderAllowedApplications(){
    const container =
        $("applicationList");

    if(!container)
        return;

    container.innerHTML = "";

    ALLOWED_APPLICATIONS.forEach(
        app => {
            const item =
                document.createElement(
                    "div"
                );

            item.className =
                "appItem";

            item.innerHTML =
                `<span>${app.displayName}</span>` +
                `<span class="appAllowed">ALLOWED</span>`;

            container.appendChild(
                item
            );
        }
    );
}

function setButtonVisibility(
    id,
    visible
){
    const element =
        $(id);

    if(!element)
        return;

    element.hidden =
        !visible;
}

function renderActiveControls(
    block
){
    const settings =
        block?.settings ??
        {};

    const allowStop =
        settings.allowStop !== undefined
            ? settings.allowStop
            : settings.AllowStop !== false;

    const allowExtend =
        settings.allowExtend === true ||
        settings.AllowExtend === true;

    const allowEmergency =
        settings.allowEmergencies === true ||
        settings.AllowEmergencies === true;

    const stopButton =
        $("stopFocus");

    if(stopButton){
        stopButton.hidden =
            !allowStop;

        stopButton.disabled =
            false;
    }

    setButtonVisibility(
        "extendFocus",
        allowExtend
    );

    setButtonVisibility(
        "emergencyBreak",
        allowEmergency
    );
}

function renderBlock(){
    if(renderLock)
        return;

    renderLock = true;

    try{
        const idle =
            $("idleView");

        const active =
            $("activeView");

        if(!idle || !active)
            return;

        if(!currentBlock){
            idle.hidden = false;
            active.hidden = true;

            return;
        }

        const now =
            Date.now();

        const warningStart =
            getWarningStart(
                currentBlock
            );

        const focusStart =
            getActualFocusStart(
                currentBlock
            );

        const end =
            getEnd(
                currentBlock
            );

        if(
            !Number.isFinite(
                warningStart
            ) ||
            !Number.isFinite(
                focusStart
            ) ||
            !Number.isFinite(
                end
            )
        ){
            currentBlock = null;

            idle.hidden = false;
            active.hidden = true;

            return;
        }

        if(now >= end){
            currentBlock = null;

            idle.hidden = false;
            active.hidden = true;

            if($("syncText")){
                $("syncText").textContent =
                    "Focus block ended.";
            }

            return;
        }

        idle.hidden = true;
        active.hidden = false;

        if($("activeName")){
            $("activeName").textContent =
                currentBlock.name;
        }

        const safety =
            now < focusStart;

        if(safety){
            const remainingSafety =
                focusStart - now;

            if($("timer")){
                $("timer").textContent =
                    formatShortRemaining(
                        remainingSafety
                    );
            }

            if($("activeLabel")){
                $("activeLabel").textContent =
                    "FOCUS STARTING";
            }

            if($("endsAt")){
                $("endsAt").textContent =
                    `Focus starts at ${
                        new Date(
                            focusStart
                        ).toLocaleTimeString()
                    } · Full ${
                        Math.round(
                            (
                                end -
                                focusStart
                            ) / 60000
                        )
                    } minute focus`;
            }

            const warningText =
                $("warningText");

            if(warningText){
                warningText.hidden = false;

                warningText.textContent =
                    `Focus will start at ${
                        new Date(
                            focusStart
                        ).toLocaleTimeString()
                    }. Safety window: ${
                        formatShortRemaining(
                            remainingSafety
                        )
                    } remaining.`;
            }
        }
        else{
            if($("activeLabel")){
                $("activeLabel").textContent =
                    "FOCUS ACTIVE";
            }

            const settings =
                currentBlock.settings ??
                {};

            const timerDisplay =
                settings.timerDisplay ??
                settings.TimerDisplay ??
                "Remaining";

            const showSeconds =
                settings.showSeconds !== false &&
                settings.ShowSeconds !== false;

            const remaining =
                Math.max(
                    0,
                    end - now
                );

            const elapsed =
                Math.max(
                    0,
                    now - focusStart
                );

            if($("warningText")){
                $("warningText").hidden = true;
            }

            if($("timer")){
                if(
                    timerDisplay ===
                    "Elapsed"
                ){
                    $("timer").textContent =
                        formatRemaining(
                            elapsed
                        );
                }
                else if(
                    timerDisplay ===
                    "Both"
                ){
                    $("timer").textContent =
                        `${formatRemaining(
                            remaining
                        )} / ${formatRemaining(
                            elapsed
                        )}`;
                }
                else{
                    $("timer").textContent =
                        formatRemaining(
                            remaining
                        );
                }

                if(!showSeconds){
                    const total =
                        Math.max(
                            0,
                            Math.floor(
                                remaining / 60000
                            )
                        );

                    if(
                        timerDisplay ===
                        "Remaining"
                    ){
                        $("timer").textContent =
                            `${String(
                                Math.floor(
                                    total / 60
                                )
                            ).padStart(2,"0")}:` +
                            `${String(
                                total % 60
                            ).padStart(2,"0")}`;
                    }
                }
            }

            if($("endsAt")){
                $("endsAt").textContent =
                    `Ends ${
                        new Date(
                            end
                        ).toLocaleString()
                    }`;
            }
        }

        renderActiveControls(
            currentBlock
        );
    }
    finally{
        renderLock = false;
    }
}

async function loadCurrentBlock(){
    const {
        data:{
            user
        },
        error:userError
    } =
        await db.auth.getUser();

    if(userError)
        throw userError;

    if(!user)
        return null;

    const {
        data,
        error
    } =
        await db
            .from("focus_blocks")
            .select("*")
            .eq(
                "user_id",
                user.id
            )
            .order(
                "starts_at",
                {
                    ascending:false
                }
            )
            .limit(100);

    if(error)
        throw error;

    const now =
        Date.now();

    const blocks =
        (data || [])
            .map(
                normalizeBlock
            );

    currentBlock =
        blocks.find(
            block =>
                isInsideBlockWindow(
                    block,
                    now
                )
        ) ||
        null;

    renderBlock();

    renderAllowedApplications();

    if($("syncText")){
        $("syncText").textContent =
            currentBlock
                ? "Active Focus Block synced."
                : "Ready. No active Focus Block.";
    }

    return currentBlock;
}

function getStartTime(){
    if(!scheduledStart)
        return new Date();

    const date =
        $("startDate")?.value;

    const time =
        $("startTime")?.value;

    if(!date || !time){
        throw new Error(
            "Choose a start date and time."
        );
    }

    const result =
        new Date(
            `${date}T${time}`
        );

    if(
        Number.isNaN(
            result.getTime()
        )
    ){
        throw new Error(
            "Invalid start date or time."
        );
    }

    const minimum =
        new Date(
            Date.now() +
            SAFETY_WINDOW_SECONDS * 1000
        );

    if(result <= minimum){
        throw new Error(
            `Scheduled focus must start at least ${
                SAFETY_WINDOW_SECONDS / 60
            } minutes from now.`
        );
    }

    return result;
}

function getDurationMinutes(){
    if(!customDuration)
        return selectedMinutes;

    const hours =
        Math.max(
            0,
            Number(
                $("durationHours")?.value
            ) || 0
        );

    const minutes =
        Math.max(
            0,
            Number(
                $("durationMinutes")?.value
            ) || 0
        );

    if(minutes > 59){
        throw new Error(
            "Minutes must be between 0 and 59."
        );
    }

    const total =
        hours * 60 +
        minutes;

    if(total <= 0){
        throw new Error(
            "Custom duration must be greater than zero."
        );
    }

    return total;
}

function getSchedule(){
    const type =
        $("scheduleType")?.value ||
        "once";

    let scheduleType =
        "Once";

    let days = [];

    if(type === "daily")
        scheduleType = "Daily";

    if(type === "weekdays")
        scheduleType = "Weekdays";

    if(type === "weekends")
        scheduleType = "Weekends";

    if(type === "custom"){
        scheduleType =
            "CustomDays";

        days =
            [
                ...document.querySelectorAll(
                    "#customDays input:checked"
                )
            ]
            .map(
                element =>
                    Number(
                        element.value
                    )
            );

        if(days.length === 0){
            throw new Error(
                "Select at least one day."
            );
        }
    }

    const repeatIndefinitely =
        $("repeatIndefinitely")?.checked ||
        false;

    let repeatUntil = null;

    if(
        !repeatIndefinitely &&
        $("repeatUntil")?.value
    ){
        repeatUntil =
            new Date(
                `${
                    $("repeatUntil").value
                }T23:59:59`
            ).toISOString();
    }

    return {
        Type:
            scheduleType,

        Days:
            days,

        RepeatUntilUtc:
            repeatUntil,

        RepeatIndefinitely:
            repeatIndefinitely
    };
}

function buildSettings(){
    return {
        AllowedApplications:
            ALLOWED_APPLICATIONS,

        MaxEmergencies:
            Number(
                $("maxEmergencies")?.value
            ) || 0,

        EmergencyDurationSeconds:
            Number(
                $("emergencyDuration")?.value
            ) || 0,

        EmergencyCooldownSeconds:
            Number(
                $("emergencyCooldown")?.value
            ) || 0,

        AllowEmergencies:
            $("allowEmergencies")?.checked ||
            false,

        AllowStop:
            $("allowStop")?.checked !== false,

        RequireStopConfirmation:
            $("stopConfirmation")?.checked ||
            false,

        StopConfirmationSeconds:
            Number(
                $("stopCountdown")?.value
            ) || 0,

        AllowExtend:
            $("allowExtend")?.checked ||
            false,

        MaximumExtensionSeconds:
            Number(
                $("maxExtension")?.value
            ) || 0,

        MaximumExtensions:
            Number(
                $("maxExtensions")?.value
            ) || 0,

        AllowConfigurationChanges:
            $("allowConfiguration")?.checked ||
            false,

        AllowNewApplications:
            $("allowNewApps")?.checked ||
            false,

        BlockApplications:
            $("blockApplications")?.checked !== false,

        BlockUnknownApplications:
            $("blockUnknown")?.checked ||
            false,

        EnforceOnStartup:
            $("enforceStartup")?.checked !== false,

        EnforceOffline:
            $("enforceOffline")?.checked !== false,

        EnforceAfterSleep:
            $("enforceSleep")?.checked !== false,

        EnforcementIntervalSeconds:
            Number(
                $("enforcementInterval")?.value
            ) || 2,

        NotifyBeforeStart:
            $("notifyBeforeStart")?.checked ||
            false,

        NotifyBeforeStartSeconds:
            Number(
                $("notifyStartSeconds")?.value
            ) || 0,

        NotifyOnStart:
            $("notifyStart")?.checked ||
            false,

        NotifyBeforeEnd:
            $("notifyBeforeEnd")?.checked ||
            false,

        NotifyBeforeEndSeconds:
            Number(
                $("notifyEndSeconds")?.value
            ) || 0,

        NotifyOnEnd:
            $("notifyEnd")?.checked ||
            false,

        TimerDisplay:
            $("timerDisplay")?.value ===
            "elapsed"
                ?"Elapsed"
                :
                $("timerDisplay")?.value ===
                "both"
                    ?"Both"
                    :"Remaining",

        ShowSeconds:
            $("showSeconds")?.checked !== false
    };
}

async function startFocus(){
    const {
        data:{
            user
        },
        error:userError
    } =
        await db.auth.getUser();

    if(userError)
        throw userError;

    if(!user){
        throw new Error(
            "Not authenticated."
        );
    }

    const requestedTime =
        getStartTime();

    const durationMinutes =
        getDurationMinutes();

    let warningStart;
    let actualFocusStart;

    /*
     * START NOW
     *
     * Press at 12:35
     *
     * warningStart       = 12:35
     * actualFocusStart   = 12:37
     * 5-minute end       = 12:42
     */
    if(!scheduledStart){
        warningStart =
            new Date(
                requestedTime.getTime()
            );

        actualFocusStart =
            new Date(
                warningStart.getTime() +
                SAFETY_WINDOW_SECONDS * 1000
            );
    }

    /*
     * SCHEDULED
     *
     * User chooses 12:35
     *
     * warningStart       = 12:33
     * actualFocusStart   = 12:35
     * 5-minute end       = 12:40
     */
    else{
        actualFocusStart =
            new Date(
                requestedTime.getTime()
            );

        warningStart =
            new Date(
                actualFocusStart.getTime() -
                SAFETY_WINDOW_SECONDS * 1000
            );
    }

    /*
     * CRITICAL:
     *
     * The end time is calculated from the ACTUAL
     * focus start, not the warning start.
     */
    const end =
        new Date(
            actualFocusStart.getTime() +
            durationMinutes * 60000
        );

    if(
        end <=
        actualFocusStart
    ){
        throw new Error(
            "End time must be after focus start."
        );
    }

    const schedule =
        getSchedule();

    const block = {
        id:
            crypto.randomUUID(),

        user_id:
            user.id,

        name:
            $("blockName")?.value.trim() ||
            "Focus Session",

        description:
            $("blockDescription")?.value.trim() ||
            "",

        version:
            1,

        /*
         * starts_at is the beginning of the
         * two-minute safety window.
         *
         * The Windows engine then waits 120 seconds
         * before actual enforcement.
         */
        starts_at:
            warningStart.toISOString(),

        /*
         * ends_at is ACTUAL FOCUS START + requested
         * duration.
         */
        ends_at:
            end.toISOString(),

        settings:
            buildSettings(),

        schedule:
            schedule,

        extensions:{
            safetyWindowSeconds:
                SAFETY_WINDOW_SECONDS,

            warningStartsAtUtc:
                warningStart.toISOString(),

            focusStartAtUtc:
                actualFocusStart.toISOString(),

            focusDurationSeconds:
                durationMinutes * 60,

            emergencyUses:
                0,

            extensionUses:
                0
        }
    };

    /*
     * Do not allow creation of another active block.
     */
    const existing =
        await loadCurrentBlock();

    if(existing){
        throw new Error(
            "A Focus Block is already active."
        );
    }

    const {
        data,
        error
    } =
        await db
            .from("focus_blocks")
            .insert(block)
            .select()
            .single();

    if(error)
        throw error;

    currentBlock =
        normalizeBlock(
            data
        );

    renderBlock();

    const focusTimeText =
        actualFocusStart.toLocaleTimeString();

    const endTimeText =
        end.toLocaleTimeString();

    if($("syncText")){
        if(scheduledStart){
            $("syncText").textContent =
                `Scheduled. Safety window starts at ${
                    warningStart.toLocaleTimeString()
                }. Focus starts at ${
                    focusTimeText
                } and ends at ${
                    endTimeText
                }.`;
        }
        else{
            $("syncText").textContent =
                `Focus will start at ${
                    focusTimeText
                } after the 2-minute safety window and end at ${
                    endTimeText
                }.`;
        }
    }

    await requestNotificationPermission();
}

async function updateBlock(
    changes
){
    if(!currentBlock){
        throw new Error(
            "No active Focus Block."
        );
    }

    const nextVersion =
        Number(
            currentBlock.version || 1
        ) + 1;

    const payload = {
        ...changes,

        version:
            nextVersion,

        updated_at:
            new Date().toISOString()
    };

    const {
        data,
        error
    } =
        await db
            .from("focus_blocks")
            .update(payload)
            .eq(
                "id",
                currentBlock.id
            )
            .select()
            .single();

    if(error)
        throw error;

    currentBlock =
        normalizeBlock(
            data
        );

    renderBlock();

    return currentBlock;
}

async function stopFocus(){
    if(!currentBlock)
        return;

    const settings =
        currentBlock.settings ||
        {};

    const allowStop =
        settings.allowStop !== undefined
            ? settings.allowStop
            : settings.AllowStop;

    if(allowStop === false){
        throw new Error(
            "This Focus Block does not allow stopping."
        );
    }

    const requireConfirmation =
        settings.requireStopConfirmation !== undefined
            ? settings.requireStopConfirmation
            : settings.RequireStopConfirmation;

    if(requireConfirmation){
        const seconds =
            Number(
                settings.stopConfirmationSeconds ??
                settings.StopConfirmationSeconds ??
                0
            ) || 0;

        if(seconds > 0){
            const button =
                $("stopFocus");

            if(button)
                button.disabled = true;

            for(
                let i = seconds;
                i > 0;
                i--
            ){
                if(button){
                    button.textContent =
                        `Stop Focus (${i})`;
                }

                await new Promise(
                    resolve =>
                        setTimeout(
                            resolve,
                            1000
                        )
                );
            }

            if(button){
                button.textContent =
                    "Stop Focus";

                button.disabled = false;
            }
        }

        if(
            !confirm(
                "Are you sure you want to stop this focus block?"
            )
        ){
            return;
        }
    }

    const now =
        new Date();

    await updateBlock({
        ends_at:
            now.toISOString()
    });

    currentBlock = null;

    renderBlock();

    if($("syncText")){
        $("syncText").textContent =
            "Focus block stopped.";
    }
}

async function extendFocus(){
    if(!currentBlock)
        return;

    const settings =
        currentBlock.settings ||
        {};

    const allowed =
        settings.allowExtend === true ||
        settings.AllowExtend === true;

    if(!allowed){
        throw new Error(
            "Extensions are disabled for this Focus Block."
        );
    }

    const maximumSeconds =
        Number(
            settings.maximumExtensionSeconds ??
            settings.MaximumExtensionSeconds ??
            0
        ) || 0;

    const maximumExtensions =
        Number(
            settings.maximumExtensions ??
            settings.MaximumExtensions ??
            0
        ) || 0;

    const extensions =
        currentBlock.extensions ||
        {};

    const uses =
        Number(
            extensions.extensionUses ??
            0
        );

    if(
        maximumExtensions > 0 &&
        uses >= maximumExtensions
    ){
        throw new Error(
            "Maximum number of extensions has been used."
        );
    }

    if(maximumSeconds <= 0){
        throw new Error(
            "No extension duration is configured."
        );
    }

    const maximumMinutes =
        Math.max(
            1,
            Math.floor(
                maximumSeconds / 60
            )
        );

    const answer =
        prompt(
            `Extend focus by how many minutes? Maximum: ${maximumMinutes}`,
            "5"
        );

    if(answer === null)
        return;

    const requested =
        Number(
            answer
        );

    if(
        !Number.isFinite(
            requested
        ) ||
        requested <= 0
    ){
        throw new Error(
            "Enter a valid extension duration."
        );
    }

    const seconds =
        Math.min(
            maximumSeconds,
            Math.floor(
                requested * 60
            )
        );

    const newEnd =
        new Date(
            getEnd(currentBlock) +
            seconds * 1000
        );

    await updateBlock({
        ends_at:
            newEnd.toISOString(),

        extensions:{
            ...extensions,

            extensionUses:
                uses + 1,

            lastExtensionSeconds:
                seconds,

            lastExtensionAtUtc:
                new Date().toISOString()
        }
    });

    if($("syncText")){
        $("syncText").textContent =
            `Focus extended by ${
                Math.ceil(
                    seconds / 60
                )
            } minute(s).`;
    }
}

async function emergencyBreak(){
    if(!currentBlock)
        return;

    const settings =
        currentBlock.settings ||
        {};

    const allowed =
        settings.allowEmergencies === true ||
        settings.AllowEmergencies === true;

    if(!allowed){
        throw new Error(
            "Emergency breaks are disabled for this Focus Block."
        );
    }

    const maximum =
        Number(
            settings.maxEmergencies ??
            settings.MaxEmergencies ??
            0
        ) || 0;

    const duration =
        Number(
            settings.emergencyDurationSeconds ??
            settings.EmergencyDurationSeconds ??
            0
        ) || 0;

    const cooldown =
        Number(
            settings.emergencyCooldownSeconds ??
            settings.EmergencyCooldownSeconds ??
            0
        ) || 0;

    const extensions =
        currentBlock.extensions ||
        {};

    const uses =
        Number(
            extensions.emergencyUses ??
            0
        );

    if(
        maximum > 0 &&
        uses >= maximum
    ){
        throw new Error(
            "Maximum emergency breaks have been used."
        );
    }

    if(duration <= 0){
        throw new Error(
            "Emergency break duration is not configured."
        );
    }

    if(
        Date.now() <
        emergencyCooldownUntil
    ){
        throw new Error(
            `Emergency break is on cooldown for ${
                formatShortRemaining(
                    emergencyCooldownUntil -
                    Date.now()
                )
            }.`
        );
    }

    const now =
        Date.now();

    const emergencyEnd =
        new Date(
            now +
            duration * 1000
        );

    await updateBlock({
        extensions:{
            ...extensions,

            emergencyUses:
                uses + 1,

            emergencyUntilUtc:
                emergencyEnd.toISOString(),

            lastEmergencyDurationSeconds:
                duration,

            lastEmergencyAtUtc:
                new Date().toISOString()
        }
    });

    emergencyCooldownUntil =
        Date.now() +
        cooldown * 1000;

    if($("syncText")){
        $("syncText").textContent =
            `Emergency break active for ${
                formatShortRemaining(
                    duration * 1000
                )
            }.`;
    }
}

async function requestNotificationPermission(){
    if(
        !("Notification" in window)
    ){
        return;
    }

    if(
        Notification.permission ===
        "default"
    ){
        try{
            await Notification.requestPermission();
        }
        catch{
        }
    }
}

function sendNotification(
    title,
    body,
    key
){
    if(
        !("Notification" in window)
    ){
        return;
    }

    if(
        Notification.permission !==
        "granted"
    ){
        return;
    }

    if(
        lastNotificationState[key]
    ){
        return;
    }

    lastNotificationState[key] =
        true;

    try{
        new Notification(
            title,
            {
                body
            }
        );
    }
    catch{
    }
}

function handleNotifications(){
    if(!currentBlock)
        return;

    const settings =
        currentBlock.settings ||
        {};

    const now =
        Date.now();

    const warningStart =
        getWarningStart(
            currentBlock
        );

    const focusStart =
        getActualFocusStart(
            currentBlock
        );

    const end =
        getEnd(
            currentBlock
        );

    const notifyBeforeStart =
        settings.notifyBeforeStart === true ||
        settings.NotifyBeforeStart === true;

    const beforeStart =
        Number(
            settings.notifyBeforeStartSeconds ??
            settings.NotifyBeforeStartSeconds ??
            0
        ) || 0;

    const notifyOnStart =
        settings.notifyOnStart === true ||
        settings.NotifyOnStart === true;

    const notifyBeforeEnd =
        settings.notifyBeforeEnd === true ||
        settings.NotifyBeforeEnd === true;

    const beforeEnd =
        Number(
            settings.notifyBeforeEndSeconds ??
            settings.NotifyBeforeEndSeconds ??
            0
        ) || 0;

    const notifyOnEnd =
        settings.notifyOnEnd === true ||
        settings.NotifyOnEnd === true;

    /*
     * "Before start" refers to the actual focus start,
     * not the beginning of the safety window.
     */
    if(
        notifyBeforeStart &&
        beforeStart > 0 &&
        now >=
            focusStart -
            beforeStart * 1000 &&
        now < focusStart
    ){
        sendNotification(
            "FocusClient",
            `Focus starts at ${
                new Date(
                    focusStart
                ).toLocaleTimeString()
            }.`,
            `before-focus-${currentBlock.id}`
        );
    }

    /*
     * The safety-window notification is separate.
     */
    if(
        notifyOnStart &&
        now >= warningStart &&
        now < warningStart + 5000
    ){
        sendNotification(
            "FocusClient",
            `Safety window started. Focus begins at ${
                new Date(
                    focusStart
                ).toLocaleTimeString()
            }.`,
            `safety-${currentBlock.id}`
        );
    }

    if(
        notifyBeforeEnd &&
        beforeEnd > 0 &&
        now >=
            end -
            beforeEnd * 1000 &&
        now < end
    ){
        sendNotification(
            "FocusClient",
            "Your Focus Block is ending soon.",
            `before-end-${currentBlock.id}`
        );
    }

    if(
        notifyOnEnd &&
        now >= end &&
        now < end + 5000
    ){
        sendNotification(
            "FocusClient",
            "Your Focus Block has ended.",
            `end-${currentBlock.id}`
        );
    }
}

async function subscribePrimaryRealtime(){
    if(primaryRealtimeChannel){
        try{
            await db.removeChannel(
                primaryRealtimeChannel
            );
        }
        catch{
        }

        primaryRealtimeChannel = null;
    }

    const {
        data:{
            user
        }
    } =
        await db.auth.getUser();

    if(!user)
        return;

    primaryRealtimeChannel =
        db
            .channel(
                `focusclient-phone-${user.id}`
            )
            .on(
                "postgres_changes",
                {
                    event:"*",
                    schema:"public",
                    table:"focus_blocks",
                    filter:
                        `user_id=eq.${user.id}`
                },
                payload => {
                    try{
                        if(
                            payload.eventType ===
                            "DELETE"
                        ){
                            if(
                                currentBlock &&
                                currentBlock.id ===
                                payload.old?.id
                            ){
                                currentBlock = null;

                                renderBlock();

                                if($("syncText")){
                                    $("syncText").textContent =
                                        "Focus block ended.";
                                }
                            }

                            return;
                        }

                        if(
                            payload.new
                        ){
                            const block =
                                normalizeBlock(
                                    payload.new
                                );

                            if(
                                isInsideBlockWindow(
                                    block
                                )
                            ){
                                currentBlock =
                                    block;

                                renderBlock();

                                if($("syncText")){
                                    $("syncText").textContent =
                                        "Focus Block synchronized.";
                                }
                            }
                            else if(
                                currentBlock &&
                                currentBlock.id ===
                                block.id
                            ){
                                currentBlock = null;

                                renderBlock();

                                if($("syncText")){
                                    $("syncText").textContent =
                                        "Focus block ended.";
                                }
                            }
                        }
                    }
                    catch(error){
                        console.error(
                            "Realtime Focus Block update failed:",
                            error
                        );
                    }
                }
            )
            .subscribe(
                status => {
                    if(status === "SUBSCRIBED"){
                        setStatus(
                            "Connected",
                            true
                        );
                    }
                    else if(
                        status ===
                        "CHANNEL_ERROR"
                    ){
                        setStatus(
                            "Realtime error",
                            false
                        );
                    }
                    else if(
                        status ===
                        "TIMED_OUT"
                    ){
                        setStatus(
                            "Realtime timeout",
                            false
                        );
                    }
                }
            );
}

async function login(){
    if($("authError")){
        $("authError").textContent = "";
    }

    const button =
        $("signIn");

    if(button){
        button.disabled = true;
        button.textContent =
            "Signing in...";
    }

    try{
        const {
            data,
            error
        } =
            await db.auth.signInWithPassword({
                email:
                    $("email")?.value.trim(),

                password:
                    $("password")?.value
            });

        if(error)
            throw error;

        if(!data.session){
            throw new Error(
                "Supabase did not return a session."
            );
        }

        /*
         * The browser/phone is PRIMARY.
         *
         * The Windows application is SECONDARY
         * and registers itself independently.
         */
        await registerPrimaryDevice();

        showApp();

        setStatus(
            "Connected",
            true
        );

        await loadCurrentBlock();

        await subscribePrimaryRealtime();

        await requestNotificationPermission();

        if($("syncText")){
            $("syncText").textContent =
                `Phone connected as primary · ${APP_VERSION}`;
        }
    }
    catch(error){
        console.error(
            "Phone login failed:",
            error
        );

        if($("authError")){
            $("authError").textContent =
                error?.message ||
                "Sign in failed.";
        }
    }
    finally{
        if(button){
            button.disabled = false;
            button.textContent =
                "Sign in";
        }
    }
}

async function restoreSession(){
    try{
        const {
            data
        } =
            await db.auth.getSession();

        if(
            !data.session
        ){
            showLogin();
            return;
        }

        showApp();

        setStatus(
            "Connected",
            true
        );

        /*
         * Make sure this browser is still the
         * registered PRIMARY device.
         */
        try{
            await registerPrimaryDevice();
        }
        catch(error){
            console.warn(
                "Primary registration during restore failed:",
                error
            );
        }

        await loadCurrentBlock();

        await subscribePrimaryRealtime();

        if($("syncText")){
            $("syncText").textContent =
                `Primary phone connected · ${APP_VERSION}`;
        }
    }
    catch(error){
        console.error(
            "Session restore failed:",
            error
        );

        showLogin();

        setStatus(
            "Not signed in",
            false
        );
    }
}

async function logout(){
    if(primaryRealtimeChannel){
        try{
            await db.removeChannel(
                primaryRealtimeChannel
            );
        }
        catch{
        }

        primaryRealtimeChannel = null;
    }

    await db.auth.signOut();

    currentBlock = null;

    showLogin();

    setStatus(
        "Not signed in",
        false
    );
}

window.focusClientUpdate =
    data => {
        if(!data)
            return;

        if(
            data.online !== undefined
        ){
            setStatus(
                data.online
                    ?"Connected"
                    :"Offline",
                data.online
            );
        }

        if(data.block){
            currentBlock =
                normalizeBlock(
                    data.block
                );

            renderBlock();

            return;
        }

        if(
            data.block === null
        ){
            currentBlock = null;

            renderBlock();
        }
    };

window.focusClientError =
    message => {
        if($("syncText")){
            $("syncText").textContent =
                message ||
                "FocusClient error.";
        }
    };

$("signIn")?.addEventListener(
    "click",
    login
);

$("signOut")?.addEventListener(
    "click",
    logout
);

$("password")?.addEventListener(
    "keydown",
    event => {
        if(
            event.key ===
            "Enter"
        ){
            login();
        }
    }
);

document
    .querySelectorAll(
        ".duration"
    )
    .forEach(
        button => {
            button.addEventListener(
                "click",
                () => {
                    document
                        .querySelectorAll(
                            ".duration"
                        )
                        .forEach(
                            item =>
                                item.classList.remove(
                                    "active"
                                )
                        );

                    button.classList.add(
                        "active"
                    );

                    if(
                        button.dataset.minutes ===
                        "custom"
                    ){
                        customDuration =
                            true;

                        if(
                            $("customDuration")
                        ){
                            $("customDuration").hidden =
                                false;
                        }

                        return;
                    }

                    customDuration =
                        false;

                    if(
                        $("customDuration")
                    ){
                        $("customDuration").hidden =
                            true;
                    }

                    selectedMinutes =
                        Number(
                            button.dataset.minutes
                        );
                }
            );
        }
    );

function selectCustomDuration(){
    customDuration = true;

    document
        .querySelectorAll(
            ".duration"
        )
        .forEach(
            item =>
                item.classList.remove(
                    "active"
                )
        );

    const customButton =
        document.querySelector(
            '.duration[data-minutes="custom"]'
        );

    if(customButton){
        customButton.classList.add(
            "active"
        );
    }

    if($("customDuration")){
        $("customDuration").hidden =
            false;
    }
}

$("durationHours")?.addEventListener(
    "input",
    selectCustomDuration
);

$("durationMinutes")?.addEventListener(
    "input",
    selectCustomDuration
);

document
    .querySelectorAll(
        "[data-start]"
    )
    .forEach(
        button => {
            button.addEventListener(
                "click",
                () => {
                    document
                        .querySelectorAll(
                            "[data-start]"
                        )
                        .forEach(
                            item =>
                                item.classList.remove(
                                    "active"
                                )
                        );

                    button.classList.add(
                        "active"
                    );

                    scheduledStart =
                        button.dataset.start ===
                        "scheduled";

                    if(
                        $("scheduleControls")
                    ){
                        $("scheduleControls").hidden =
                            !scheduledStart;
                    }

                    if(
                        !scheduledStart
                    ){
                        if($("startDate"))
                            $("startDate").value =
                                "";

                        if($("startTime"))
                            $("startTime").value =
                                "";
                    }
                }
            );
        }
    );

$("scheduleType")?.addEventListener(
    "change",
    () => {
        const custom =
            $("scheduleType").value ===
            "custom";

        if($("customDays")){
            $("customDays").hidden =
                !custom;
        }

        if(!custom){
            document
                .querySelectorAll(
                    "#customDays input"
                )
                .forEach(
                    checkbox =>
                        checkbox.checked =
                            false
                );
        }
    }
);

$("repeatIndefinitely")?.addEventListener(
    "change",
    () => {
        const checked =
            $("repeatIndefinitely").checked;

        if($("repeatUntilContainer")){
            $("repeatUntilContainer").hidden =
                checked;
        }

        if(checked && $("repeatUntil")){
            $("repeatUntil").value =
                "";
        }
    }
);

$("startFocus")?.addEventListener(
    "click",
    async () => {
        const button =
            $("startFocus");

        if(button){
            button.disabled = true;
            button.textContent =
                "Creating...";
        }

        try{
            await startFocus();
        }
        catch(error){
            console.error(
                "Start Focus failed:",
                error
            );

            if($("syncText")){
                $("syncText").textContent =
                    error?.message ||
                    "Could not create Focus Block.";
            }
        }
        finally{
            if(button){
                button.disabled = false;
                button.textContent =
                    "Start Focus";
            }
        }
    }
);

$("stopFocus")?.addEventListener(
    "click",
    async () => {
        try{
            await stopFocus();
        }
        catch(error){
            console.error(
                "Stop Focus failed:",
                error
            );

            if($("syncText")){
                $("syncText").textContent =
                    error?.message ||
                    "Could not stop Focus.";
            }
        }
    }
);

$("extendFocus")?.addEventListener(
    "click",
    async () => {
        try{
            await extendFocus();
        }
        catch(error){
            console.error(
                "Extend Focus failed:",
                error
            );

            if($("syncText")){
                $("syncText").textContent =
                    error?.message ||
                    "Could not extend Focus.";
            }
        }
    }
);

$("emergencyBreak")?.addEventListener(
    "click",
    async () => {
        try{
            await emergencyBreak();
        }
        catch(error){
            console.error(
                "Emergency break failed:",
                error
            );

            if($("syncText")){
                $("syncText").textContent =
                    error?.message ||
                    "Could not start emergency break.";
            }
        }
    }
);

$("refreshApps")?.addEventListener(
    "click",
    () => {
        renderAllowedApplications();

        if($("syncText")){
            $("syncText").textContent =
                "Applications refreshed.";
        }
    }
);

if($("customDuration")){
    $("customDuration").hidden =
        true;
}

if($("scheduleControls")){
    $("scheduleControls").hidden =
        true;
}

if($("customDays")){
    $("customDays").hidden =
        true;
}

if($("repeatUntilContainer")){
    $("repeatUntilContainer").hidden =
        false;
}

setInterval(
    () => {
        renderBlock();
        handleNotifications();
    },
    250
);

showLogin();

renderAllowedApplications();

setStatus(
    "Not signed in",
    false
);

restoreSession();
