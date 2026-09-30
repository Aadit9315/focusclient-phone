const SUPABASE_URL="https://rwyvjlwwjygrqvaiyobj.supabase.co";
const SUPABASE_PUBLISHABLE_KEY="sb_publishable_LGLdZYFCV-K6x5ltCmsmyA_n839DQ_T";

const db=supabase.createClient(
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

let selectedMinutes=60;
let customDuration=false;
let scheduledStart=false;
let currentBlock=null;

const $=id=>document.getElementById(id);

const DEVICE_ID_KEY="focusclient_device_id";

function getDeviceId(){
    let id=localStorage.getItem(DEVICE_ID_KEY);

    if(!id){
        id=crypto.randomUUID();
        localStorage.setItem(DEVICE_ID_KEY,id);
    }

    return id;
}

function getDeviceName(){
    const userAgent=navigator.userAgent;

    if(userAgent.includes("iPhone"))
        return "iPhone";

    if(userAgent.includes("iPad"))
        return "iPad";

    if(userAgent.includes("Android"))
        return "Android Phone";

    return "FocusClient Phone";
}

function getDevicePlatform(){
    const userAgent=navigator.userAgent;

    if(userAgent.includes("iPhone")||userAgent.includes("iPad"))
        return "ios";

    if(userAgent.includes("Android"))
        return "android";

    return "web";
}

async function registerPrimaryDevice(){
    const deviceId=getDeviceId();
    const deviceName=getDeviceName();
    const platform=getDevicePlatform();

    const {
        data,
        error
    }=await db.rpc(
        "register_primary_device",
        {
            p_device_id:deviceId,
            p_device_name:deviceName,
            p_platform:platform
        }
    );

    if(error)
        throw error;

    return data;
}

const ALLOWED_APPLICATIONS=[
    {
        applicationKey:"",
        displayName:"Microsoft Word",
        executablePath:"C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE",
        processName:"WINWORD"
    },
    {
        applicationKey:"",
        displayName:"Windows Settings",
        executablePath:"C:\\Windows\\ImmersiveControlPanel\\SystemSettings.exe",
        processName:"SystemSettings"
    },
    {
        applicationKey:"",
        displayName:"File Explorer",
        executablePath:"C:\\Windows\\Explorer.EXE",
        processName:"explorer"
    }
];

function sendNative(message){
    if(window.chrome&&window.chrome.webview)
        window.chrome.webview.postMessage(JSON.stringify(message));
}

function setStatus(text,online){
    $("status").textContent=text;
    $("status").className=`status ${online?"online":"offline"}`;
}

function showApp(){
    $("authView").hidden=true;
    $("appView").hidden=false;
}

function showLogin(){
    $("authView").hidden=false;
    $("appView").hidden=true;
}

function formatRemaining(ms){
    const total=Math.max(0,Math.floor(ms/1000));
    const h=Math.floor(total/3600);
    const m=Math.floor((total%3600)/60);
    const s=total%60;

    return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}

function renderAllowedApplications(){
    const container=$("applicationList");

    if(!container)
        return;

    container.innerHTML="";

    ALLOWED_APPLICATIONS.forEach(app=>{
        const item=document.createElement("div");

        item.className="appItem";

        item.innerHTML=
            `<span>${app.displayName}</span>`+
            `<span class="appAllowed">ALLOWED</span>`;

        container.appendChild(item);
    });
}

function renderBlock(){
    if(!currentBlock){
        $("idleView").hidden=false;
        $("activeView").hidden=true;
        return;
    }

    const now=Date.now();
    const start=new Date(currentBlock.starts_at).getTime();
    const end=new Date(currentBlock.ends_at).getTime();

    const active=
        now>=start&&
        now<end;

    $("idleView").hidden=active;
    $("activeView").hidden=!active;

    if(active){
        $("activeName").textContent=currentBlock.name;

        $("timer").textContent=
            formatRemaining(end-now);

        $("endsAt").textContent=
            `Ends ${new Date(end).toLocaleString()}`;
    }
}

async function loadCurrentBlock(){
    const {
        data:{user},
        error:userError
    }=await db.auth.getUser();

    if(userError)
        throw userError;

    if(!user)
        return;

    const {
        data,
        error
    }=await db
        .from("focus_blocks")
        .select("*")
        .eq("user_id",user.id)
        .order("starts_at",{ascending:false})
        .limit(100);

    if(error)
        throw error;

    const now=Date.now();

    currentBlock=
        (data||[]).find(block=>{
            const start=
                new Date(block.starts_at).getTime();

            const end=
                new Date(block.ends_at).getTime();

            return now>=start&&now<end;
        })||null;

    renderBlock();
    renderAllowedApplications();

    $("syncText").textContent=
        `Synced ${new Date().toLocaleTimeString()}`;
}

function getStartTime(){
    if(!scheduledStart)
        return new Date();

    const date=$("startDate").value;
    const time=$("startTime").value;

    if(!date||!time)
        throw new Error(
            "Choose a start date and time."
        );

    const result=
        new Date(`${date}T${time}`);

    if(Number.isNaN(result.getTime()))
        throw new Error(
            "Invalid start date or time."
        );

    if(result<=new Date())
        throw new Error(
            "Scheduled start must be in the future."
        );

    return result;
}

function getDurationMinutes(){
    if(!customDuration)
        return selectedMinutes;

    const hours=
        Math.max(
            0,
            Number($("durationHours").value)||0
        );

    const minutes=
        Math.max(
            0,
            Number($("durationMinutes").value)||0
        );

    if(minutes>59)
        throw new Error(
            "Minutes must be between 0 and 59."
        );

    const total=
        hours*60+
        minutes;

    if(total<=0)
        throw new Error(
            "Custom duration must be greater than zero."
        );

    return total;
}

function getSchedule(){
    const type=$("scheduleType").value;

    let scheduleType="Once";
    let days=[];

    if(type==="daily")
        scheduleType="Daily";

    if(type==="weekdays")
        scheduleType="Weekdays";

    if(type==="weekends")
        scheduleType="Weekends";

    if(type==="custom"){
        scheduleType="CustomDays";

        days=[
            ...document.querySelectorAll(
                "#customDays input:checked"
            )
        ].map(x=>Number(x.value));

        if(days.length===0)
            throw new Error(
                "Select at least one day."
            );
    }

    const repeatIndefinitely=
        $("repeatIndefinitely").checked;

    let repeatUntil=null;

    if(
        !repeatIndefinitely&&
        $("repeatUntil").value
    ){
        repeatUntil=
            new Date(
                `${$("repeatUntil").value}T23:59:59`
            ).toISOString();
    }

    return {
        Type:scheduleType,
        Days:days,
        RepeatUntilUtc:repeatUntil,
        RepeatIndefinitely:repeatIndefinitely
    };
}

function buildSettings(){
    return {
        AllowedApplications:
            ALLOWED_APPLICATIONS,

        MaxEmergencies:
            Number(
                $("maxEmergencies").value
            )||0,

        EmergencyDurationSeconds:
            Number(
                $("emergencyDuration").value
            )||0,

        EmergencyCooldownSeconds:
            Number(
                $("emergencyCooldown").value
            )||0,

        AllowEmergencies:
            $("allowEmergencies").checked,

        AllowStop:
            $("allowStop").checked,

        RequireStopConfirmation:
            $("stopConfirmation").checked,

        StopConfirmationSeconds:
            Number(
                $("stopCountdown").value
            )||0,

        AllowExtend:
            $("allowExtend").checked,

        MaximumExtensionSeconds:
            Number(
                $("maxExtension").value
            )||0,

        MaximumExtensions:
            Number(
                $("maxExtensions").value
            )||0,

        AllowConfigurationChanges:
            $("allowConfiguration").checked,

        AllowNewApplications:
            $("allowNewApps").checked,

        BlockApplications:
            $("blockApplications").checked,

        BlockUnknownApplications:
            $("blockUnknown").checked,

        EnforceOnStartup:
            $("enforceStartup").checked,

        EnforceOffline:
            $("enforceOffline").checked,

        EnforceAfterSleep:
            $("enforceSleep").checked,

        EnforcementIntervalSeconds:
            Number(
                $("enforcementInterval").value
            )||2,

        NotifyBeforeStart:
            $("notifyBeforeStart").checked,

        NotifyBeforeStartSeconds:
            Number(
                $("notifyStartSeconds").value
            )||0,

        NotifyOnStart:
            $("notifyStart").checked,

        NotifyBeforeEnd:
            $("notifyBeforeEnd").checked,

        NotifyBeforeEndSeconds:
            Number(
                $("notifyEndSeconds").value
            )||0,

        NotifyOnEnd:
            $("notifyEnd").checked,

        TimerDisplay:
            $("timerDisplay").value==="remaining"
                ?"Remaining"
                :$("timerDisplay").value==="elapsed"
                    ?"Elapsed"
                    :"Both",

        ShowSeconds:
            $("showSeconds").checked
    };
}

async function startFocus(){
    const {
        data:{user},
        error:userError
    }=await db.auth.getUser();

    if(userError)
        throw userError;

    if(!user)
        throw new Error(
            "Not authenticated."
        );

    const start=getStartTime();

    const durationMinutes=
        getDurationMinutes();

    const end=
        new Date(
            start.getTime()+
            durationMinutes*60000
        );

    if(end<=start)
        throw new Error(
            "End time must be after start time."
        );

    const schedule=getSchedule();

    const block={
        id:crypto.randomUUID(),

        user_id:user.id,

        name:
            $("blockName").value.trim()||
            "Focus Session",

        description:
            $("blockDescription").value.trim(),

        version:1,

        starts_at:
            start.toISOString(),

        ends_at:
            end.toISOString(),

        settings:
            buildSettings(),

        schedule:
            schedule,

        extensions:{}
    };

    const {
        data,
        error
    }=await db
        .from("focus_blocks")
        .insert(block)
        .select()
        .single();

    if(error)
        throw error;

    currentBlock=data;

    renderBlock();

    $("syncText").textContent=
        "Focus block created successfully.";

    sendNative({
        type:"refreshFocus"
    });
}

async function stopFocus(){
    if(!currentBlock)
        return;

    const settings=
        currentBlock.settings||{};

    if(settings.allowStop===false)
        throw new Error(
            "This Focus Block does not allow stopping."
        );

    if(settings.requireStopConfirmation){
        const seconds=
            Number(
                settings.stopConfirmationSeconds
            )||0;

        if(seconds>0){
            $("stopFocus").disabled=true;

            for(
                let i=seconds;
                i>0;
                i--
            ){
                $("stopFocus").textContent=
                    `Stop Focus (${i})`;

                await new Promise(
                    resolve=>
                        setTimeout(
                            resolve,
                            1000
                        )
                );
            }

            $("stopFocus").textContent=
                "Stop Focus";

            $("stopFocus").disabled=false;
        }

        if(!confirm(
            "Are you sure you want to stop this focus block?"
        )){
            return;
        }
    }

    const now=new Date();

    const {
        data,
        error
    }=await db
        .from("focus_blocks")
        .update({
            ends_at:
                now.toISOString(),

            version:
                (currentBlock.version||1)+1,

            updated_at:
                now.toISOString()
        })
        .eq(
            "id",
            currentBlock.id
        )
        .select()
        .single();

    if(error)
        throw error;

    currentBlock=data;

    renderBlock();

    $("syncText").textContent=
        "Focus block stopped.";

    sendNative({
        type:"refreshFocus"
    });
}

async function login(){
    $("authError").textContent="";

    $("signIn").disabled=true;

    $("signIn").textContent=
        "Signing in...";

    try{
        const {
            data,
            error
        }=await db.auth.signInWithPassword({
            email:
                $("email").value.trim(),

            password:
                $("password").value
        });

        if(error)
            throw error;

        if(!data.session)
            throw new Error(
                "Supabase did not return a session."
            );

        await registerPrimaryDevice();

        sendNative({
            type:"authenticated",

            accessToken:
                data.session.access_token,

            refreshToken:
                data.session.refresh_token
        });

        showApp();

        setStatus(
            "Connected",
            true
        );

        await loadCurrentBlock();

        renderAllowedApplications();
    }
    catch(error){
        $("authError").textContent=
            error?.message||
            "Sign in failed.";
    }
    finally{
        $("signIn").disabled=false;

        $("signIn").textContent=
            "Sign in";
    }
}

async function logout(){
    await db.auth.signOut();

    currentBlock=null;

    sendNative({
        type:"logout"
    });

    showLogin();

    setStatus(
        "Not signed in",
        false
    );
}

window.focusClientApplications=()=>{
    renderAllowedApplications();
};

window.focusClientUpdate=data=>{
    if(!data)
        return;

    setStatus(
        data.online
            ?"Connected"
            :"Offline",
        data.online
    );

    if(data.block){
        currentBlock={
            id:data.block.id,

            name:data.block.name,

            version:data.block.version,

            starts_at:
                data.block.startsAt,

            ends_at:
                data.block.endsAt,

            settings:
                data.block.settings
        };

        renderBlock();

        return;
    }

    if(!currentBlock)
        renderBlock();
};

window.focusClientError=message=>{
    $("syncText").textContent=
        message||
        "FocusClient error";
};

$("signIn").onclick=login;

$("signOut").onclick=logout;

$("password").onkeydown=e=>{
    if(e.key==="Enter")
        login();
};

document
    .querySelectorAll(".duration")
    .forEach(button=>{
        button.onclick=()=>{
            document
                .querySelectorAll(".duration")
                .forEach(x=>
                    x.classList.remove("active")
                );

            button.classList.add("active");

            if(
                button.dataset.minutes===
                "custom"
            ){
                customDuration=true;

                $("customDuration").hidden=
                    false;

                return;
            }

            customDuration=false;

            $("customDuration").hidden=
                true;

            selectedMinutes=
                Number(
                    button.dataset.minutes
                );
        };
    });

function selectCustomDuration(){
    customDuration=true;

    document
        .querySelectorAll(".duration")
        .forEach(x=>
            x.classList.remove("active")
        );

    const customButton=
        document.querySelector(
            '.duration[data-minutes="custom"]'
        );

    if(customButton)
        customButton.classList.add(
            "active"
        );

    $("customDuration").hidden=false;
}

$("durationHours").addEventListener(
    "input",
    selectCustomDuration
);

$("durationMinutes").addEventListener(
    "input",
    selectCustomDuration
);

document
    .querySelectorAll("[data-start]")
    .forEach(button=>{
        button.onclick=()=>{
            document
                .querySelectorAll("[data-start]")
                .forEach(x=>
                    x.classList.remove(
                        "active"
                    )
                );

            button.classList.add(
                "active"
            );

            scheduledStart=
                button.dataset.start===
                "scheduled";

            $("scheduleControls").hidden=
                !scheduledStart;

            if(!scheduledStart){
                $("startDate").value="";
                $("startTime").value="";
            }
        };
    });

$("scheduleType").onchange=()=>{
    $("customDays").hidden=
        $("scheduleType").value!=="custom";

    if(
        $("scheduleType").value!==
        "custom"
    ){
        document
            .querySelectorAll(
                "#customDays input"
            )
            .forEach(x=>
                x.checked=false
            );
    }
};

$("repeatIndefinitely").onchange=()=>{
    $("repeatUntilContainer").hidden=
        $("repeatIndefinitely").checked;

    if(
        $("repeatIndefinitely").checked
    ){
        $("repeatUntil").value="";
    }
};

$("startFocus").onclick=async()=>{
    $("startFocus").disabled=true;

    try{
        await startFocus();
    }
    catch(error){
        $("syncText").textContent=
            error?.message||
            "Could not create focus block.";
    }

    $("startFocus").disabled=false;
};

$("stopFocus").onclick=async()=>{
    try{
        await stopFocus();
    }
    catch(error){
        $("syncText").textContent=
            error?.message||
            "Could not stop focus.";
    }
};

$("refreshApps")?.addEventListener(
    "click",
    ()=>{
        renderAllowedApplications();

        $("syncText").textContent=
            "Applications refreshed.";
    }
);

$("customDuration").hidden=true;

$("scheduleControls").hidden=true;

$("customDays").hidden=true;

$("repeatUntilContainer").hidden=false;

setInterval(
    renderBlock,
    1000
);

showLogin();

renderAllowedApplications();

setStatus(
    "Not signed in",
    false
);
