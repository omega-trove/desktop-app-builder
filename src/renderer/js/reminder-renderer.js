/* Break-reminder popup. Extracted from an inline <script> in reminder.html so a
   strict script-src CSP can be enforced. */
(function () {
    'use strict';

    const COPY = {
        ar: { title: 'أنت في استراحة', subtitle: 'يرجى تفعيل مؤقت العمل', stop: 'إيقاف التذكير', dir: 'rtl' },
        en: { title: 'On a break', subtitle: 'Please start the timer', stop: 'Stop Reminding', dir: 'ltr' },
    };

    const locale = localStorage.getItem('tracker_locale') === 'en' ? 'en' : 'ar';
    const copy = COPY[locale];

    document.body.dir = copy.dir;
    document.getElementById('reminderTitle').innerText = copy.title;
    document.getElementById('reminderSubtitle').innerText = copy.subtitle;

    const stopBtn = document.getElementById('stopBtn');
    stopBtn.innerText = copy.stop;
    stopBtn.addEventListener('click', () => {
        if (window.electronAPI && window.electronAPI.stopRemindingClicked) {
            window.electronAPI.stopRemindingClicked();
        }
    });
})();
