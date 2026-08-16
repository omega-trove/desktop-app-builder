let API_BASE = 'https://hrm.omegatrack.ai/api';

async function initConfig() {
    try {
        const config = await window.electronAPI.getConfig();
        if (config && config.API_BASE) {
            API_BASE = config.API_BASE.startsWith('http')
                ? config.API_BASE.replace(/\/$/, '')
                : 'https://' + config.API_BASE.replace(/\/$/, '');
            console.log('✅ API_BASE loaded:', API_BASE);
        }
    } catch (e) {
        console.error('❌ Failed to load config:', e);
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    await initConfig();

    const loginBtn = document.getElementById('loginBtn');
    const errorMsg = document.getElementById('errorMsg');

    // Auto-login if secure token exists in the OS Keychain/userData file
    const storedToken = await window.electronAPI.getToken();
    if (storedToken) {
        console.log('Found secure stored token, auto-logging in...');
        window.electronAPI.navigateTo('tracker');
        return;
    }

    loginBtn.addEventListener('click', async () => {
        const email = document.getElementById('email').value.trim();
        // Do NOT trim the password. The server (and the web login form) compares the
        // password exactly as stored, so trimming here made a credential with leading
        // or trailing whitespace succeed on the web portal but fail on the desktop
        // with "Invalid credentials" for the *same* password the admin set.
        const password = document.getElementById('password').value;

        if (!email || !password) {
            errorMsg.innerText = __('email_password_required');
            errorMsg.style.display = 'block';
            return;
        }

        loginBtn.innerText = __('connecting');
        loginBtn.disabled = true;
        errorMsg.style.display = 'none';

        try {
            console.log('🔄 Attempting login to:', `${API_BASE}/auth/login`);

            const response = await fetch(`${API_BASE}/auth/login`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify({
                    email,
                    password,
                    // Tag this as a desktop login so the backend issues a
                    // 'desktop-auth-token' (its own device bucket). Without it the
                    // desktop shared the generic 'auth-token' bucket, so any other
                    // generic login for the same user silently revoked the desktop
                    // session — surfacing later as an unexpected auth failure.
                    device_type: 'desktop',
                    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
                })
            });

            console.log('📥 Response status:', response.status);

            const data = await response.json();
            console.log('📦 Response data:', data);

            const token = data.token || (data.data && data.data.token);

            if (response.ok && token) {
                console.log('✅ Login successful');
                window.electronAPI.setToken(token);
                
                const fullName = data.user ? data.user.full_name : (data.data && data.data.user ? data.data.user.full_name : null);
                if (fullName) {
                    localStorage.setItem('user_name', fullName);
                }
                
                window.electronAPI.navigateTo('tracker');
            } else {
                throw new Error(data.message || data.error || __('invalid_credentials'));
            }
        } catch (error) {
            console.error('❌ Login error:', error);
            errorMsg.innerText = error.message || __('connection_error');
            errorMsg.style.display = 'block';
        } finally {
            loginBtn.innerText = __('login_title');
            loginBtn.disabled = false;
        }
    });
});