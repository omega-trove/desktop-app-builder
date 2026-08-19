/* Renderer error boundary, shared by the login and tracker windows.
 *
 * Previously an inline <script> duplicated in both HTML files — which is why a
 * strict script-src CSP could not be applied. It also alert()ed the raw message,
 * source, line and stack at the end user, blocking the renderer behind a wall of
 * text nobody outside the team can act on. The detail still goes to the main
 * process log via IPC; the user gets a dismissible notice. */
(function () {
    'use strict';

    function report(label, detail) {
        const errInfo = label + ': ' + detail;
        console.error(errInfo);

        if (window.electronAPI && window.electronAPI.logError) {
            window.electronAPI.logError(errInfo);
        }

        if (typeof window.showToast === 'function') {
            window.showToast('Something went wrong. The problem has been logged.', { variant: 'error' });
        }
    }

    window.onerror = function (message, source, lineno, colno, error) {
        report(
            'Uncaught Error',
            message + '\nSource: ' + source + '\nLine: ' + lineno + ':' + colno +
            '\nStack: ' + (error && error.stack ? error.stack : 'none')
        );
    };

    window.addEventListener('unhandledrejection', function (event) {
        report(
            'Unhandled Rejection',
            event.reason + '\nStack: ' + (event.reason && event.reason.stack ? event.reason.stack : 'none')
        );
    });
})();
