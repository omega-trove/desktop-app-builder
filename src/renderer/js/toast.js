/* Non-blocking notifications.
 *
 * The tracker used window.alert() for everything, including from inside the
 * 60s tracking interval. alert() is synchronous and blocks the renderer's event
 * loop — which is also the loop driving the counter tick, the telemetry sync and
 * the offline flush. An idle-stop alert left on screen while the user was away
 * from the machine froze all of them until someone dismissed it.
 *
 * showToast() is a drop-in replacement that returns immediately. showBlocking()
 * remains available for the few places that genuinely need to halt the user
 * (an acknowledgement the product requires), so the distinction is explicit at
 * every call site rather than accidental. */
(function () {
    'use strict';

    const CONTAINER_ID = 'toast-container';
    const DEFAULT_MS = 6000;

    function container() {
        let el = document.getElementById(CONTAINER_ID);
        if (!el) {
            el = document.createElement('div');
            el.id = CONTAINER_ID;
            el.className = 'toast-container';
            el.setAttribute('role', 'status');
            el.setAttribute('aria-live', 'polite');
            document.body.appendChild(el);
        }
        return el;
    }

    /**
     * @param {string} message
     * @param {{ variant?: 'info'|'warn'|'error', durationMs?: number }} [options]
     */
    window.showToast = function showToast(message, options) {
        const opts = options || {};
        const toast = document.createElement('div');
        toast.className = 'toast toast-' + (opts.variant || 'info');
        toast.textContent = String(message);

        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'toast-close';
        close.setAttribute('aria-label', 'Dismiss');
        close.textContent = '×';
        close.addEventListener('click', () => toast.remove());
        toast.appendChild(close);

        container().appendChild(toast);

        const ttl = typeof opts.durationMs === 'number' ? opts.durationMs : DEFAULT_MS;
        if (ttl > 0) window.setTimeout(() => toast.remove(), ttl);

        return toast;
    };

    /** Explicitly blocking — use only where the user must acknowledge. */
    window.showBlocking = function showBlocking(message) {
        return window.alert(message);
    };
})();
