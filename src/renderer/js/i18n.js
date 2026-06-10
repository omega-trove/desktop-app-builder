const trackerLocaleKey = 'tracker_locale';
let currentLocale = localStorage.getItem(trackerLocaleKey) || 'ar'; // Default to Arabic

const dictionary = {
    en: {
        login_title: "Sign In",
        email_label: "Email Address",
        password_label: "Password",
        connecting: "Connecting...",
        email_password_required: "Please enter email and password",
        connection_error: "Cannot connect to server. Check your internet.",
        invalid_credentials: "Invalid credentials.",
        logout: "Logout",
        general_task: "General Task",
        select_task: "-- Choose Task --",
        general_work: "General Work",
        tracking_active: "Tracking active...",
        offline_tracking_active: "(Offline) Tracking active...",
        status_ready: "Ready to track",
        status_paused: "Paused",
        btn_start: "Start",
        btn_stop: "Stop",
        idle_stopped: (minutes) => `Timer stopped automatically due to inactivity for more than ${minutes} minutes.`,
        today_progress: (logged, target) => `Today's progress: ${logged} / ${target} hours`,
        in_meeting_tag: "[In Meeting] ",
        proactive_warning: (title) => `Proactive warning 🛑: The system detected a prohibited app (${title}). The timer will stop immediately!`,
        captcha_timeout: "Timer stopped automatically due to presence check failure (Anti-Cheat).",
        captcha_wrong: "Wrong code!",
        placeholder_task: "What are you working on now? (optional)",
        meeting_mode: "Meeting mode (ignore idle) 🤝",
        captcha_title: "⚠️ Presence Verification",
        captcha_desc: "Please enter the code below within 60 seconds to prove you are active and not using mouse jigglers.",
        captcha_verify_btn: (seconds) => `Verify my identity (${seconds}s remaining)`,
        error_starting: "Error starting session: ",
        error_stopping: "Error stopping session: ",
        subtitle: "Omega Track Desktop Client",
        captcha_verify_btn_init: "Verify my identity",
        status_online: "Online & Synced",
        status_syncing: "Syncing data...",
        status_offline: "Offline (Local mode)",
        focus_mode_title: "Focus Session",
        start_focus: "Start Pomodoro",
        stop_focus: "Stop Focus",
        focus_break: "Break Time! (5 mins)",
        focus_prohibited_alert: (title) => `Focus alert! Prohibited app/site (${title}) is active. Please focus on work!`,
        tracker_reminder_title: "Omega Tracker is Stopped",
        tracker_reminder_body: "Reminder ⚠️: You are currently not tracking. Please start the timer to track your work!"
    },
    ar: {
        login_title: "تسجيل الدخول",
        email_label: "البريد الإلكتروني",
        password_label: "كلمة المرور",
        connecting: "جاري الاتصال...",
        email_password_required: "يرجى إدخال البريد الإلكتروني وكلمة المرور",
        connection_error: "تعذر الاتصال بالخادم. تحقق من الاتصال بالإنترنت.",
        invalid_credentials: "بيانات الاعتماد غير صالحة.",
        logout: "تسجيل الخروج",
        general_task: "مهمة عامة",
        select_task: "-- اختر مهمة --",
        general_work: "عمل عام",
        tracking_active: "التتبع نشط...",
        offline_tracking_active: "(غير متصل) التتبع نشط...",
        status_ready: "جاهز للتتبع",
        status_paused: "متوقف مؤقتاً",
        btn_start: "بدء",
        btn_stop: "إيقاف",
        idle_stopped: (minutes) => `تم إيقاف الموقت تلقائياً لعدم وجود نشاط لأكثر من ${minutes} دقيقة.`,
        today_progress: (logged, target) => `إنجاز اليوم: ${logged} / ${target} ساعات`,
        in_meeting_tag: "[في اجتماع] ",
        proactive_warning: (title) => `تحذير استباقي 🛑: اكتشف النظام تطبيقاً ممنوعاً (${title}). سيتم إيقاف الموقت فوراً!`,
        captcha_timeout: "تم إيقاف الموقت تلقائياً لفشلك في إثبات التواجد (مكافحة التحايل).",
        captcha_wrong: "الرمز خاطئ!",
        placeholder_task: "ما الذي تعمل عليه الآن؟ (اختياري)",
        meeting_mode: "وضع الاجتماع (تجاهل الخمول) 🤝",
        captcha_title: "⚠️ تحقق النشاط الفعلي",
        captcha_desc: "يرجى إدخل الرمز أدناه خلال 60 ثانية لضمان إثبات تواجدك وعدم استخدام محاكيات الماوس.",
        captcha_verify_btn: (seconds) => `تأكيد هويتي (يتبقى ${seconds} ثانية)`,
        error_starting: "خطأ في بدء الجلسة: ",
        error_stopping: "خطأ في إيقاف الجلسة: ",
        subtitle: "عميل سطح المكتب لنظام الموارد البشرية",
        captcha_verify_btn_init: "تأكيد هويتي",
        status_online: "متصل وتم المزامنة",
        status_syncing: "مزامنة البيانات...",
        status_offline: "غير متصل (الوضع المحلي)",
        focus_mode_title: "جلسة تركيز",
        start_focus: "بدء البومودورو",
        stop_focus: "إيقاف التركيز",
        focus_break: "وقت استراحة! (5 دقائق)",
        focus_prohibited_alert: (title) => `تنبيــه تركيـز! التطبيق/الموقع الممنوع (${title}) نشط حالياً. يرجى التركيز على العمل!`,
        tracker_reminder_title: "مؤقت العمل متوقف",
        tracker_reminder_body: "تنبيه ⚠️: تتبع الوقت متوقف حالياً. يرجى تفعيل المؤقت لتسجيل ساعات العمل الخاصة بك!"
    }
};

function __(key, ...args) {
    const localeDict = dictionary[currentLocale] || dictionary['ar'];
    const translation = localeDict[key];
    if (typeof translation === 'function') {
        return translation(...args);
    }
    return translation || key;
}

function setLocale(locale) {
    if (locale === 'ar' || locale === 'en') {
        localStorage.setItem(trackerLocaleKey, locale);
        currentLocale = locale;
        applyTranslations();
        if (window.electronAPI && window.electronAPI.setLocale) {
            window.electronAPI.setLocale(locale);   // keep native dialogs in sync
        }
    }
}

function applyTranslations() {
    // 1. Set document text direction
    document.body.dir = currentLocale === 'ar' ? 'rtl' : 'ltr';
    
    // 2. Translate elements with data-i18n
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        el.innerText = __(key);
    });
    
    // 3. Translate placeholders with data-i18n-placeholder
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        el.placeholder = __(key);
    });
    
    // 4. Align layout styling based on direction
    const mainFormGroups = document.querySelectorAll('.form-group');
    mainFormGroups.forEach(el => {
        el.style.textAlign = currentLocale === 'ar' ? 'right' : 'left';
    });
    
    // 5. Update state-based status and button texts
    const statusText = document.getElementById('statusText');
    if (statusText) {
        const isTrackingActive = typeof isTracking !== 'undefined' ? isTracking : false;
        const isOffline = typeof timeLogId !== 'undefined' && timeLogId && String(timeLogId).startsWith('local_');
        
        if (isTrackingActive) {
            statusText.innerText = isOffline ? __('offline_tracking_active') : __('tracking_active');
        } else {
            const currentText = statusText.innerText;
            if (currentText === 'Paused' || currentText === 'متوقف مؤقتاً' || currentText === __('status_paused')) {
                statusText.innerText = __('status_paused');
            } else {
                statusText.innerText = __('status_ready');
            }
        }
    }
    
    const btnText = document.getElementById('btnText');
    if (btnText) {
        const isTrackingActive = typeof isTracking !== 'undefined' ? isTracking : false;
        btnText.innerText = isTrackingActive ? __('btn_stop') : __('btn_start');
    }
    
    // Update selector dropdown if present
    const langSelect = document.getElementById('langSelect');
    if (langSelect) {
        langSelect.value = currentLocale;
    }
}

// Automatically apply translations on page load
document.addEventListener('DOMContentLoaded', () => {
    applyTranslations();

    // Tell the main process the current UI language so native dialogs match it.
    if (window.electronAPI && window.electronAPI.setLocale) {
        window.electronAPI.setLocale(currentLocale);
    }

    // Attach change handler to language selector if it exists
    const langSelect = document.getElementById('langSelect');
    if (langSelect) {
        langSelect.addEventListener('change', (e) => {
            setLocale(e.target.value);
        });
    }
});
