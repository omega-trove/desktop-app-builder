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

    // Auto-login if token exists
    const storedToken = localStorage.getItem('auth_token');
    if (storedToken) {
        console.log('Found stored token, auto-logging in...');
        window.electronAPI.setToken(storedToken);
        window.electronAPI.navigateTo('tracker');
        return;
    }

    loginBtn.addEventListener('click', async () => {
        const email = document.getElementById('email').value.trim();
        const password = document.getElementById('password').value.trim();

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
                    password
                })
            });

            console.log('📥 Response status:', response.status);

            const data = await response.json();
            console.log('📦 Response data:', data);

            const token = data.token || (data.data && data.data.token);

            if (response.ok && token) {
                console.log('✅ Login successful');
                localStorage.setItem('auth_token', token);
                
                const fullName = data.user ? data.user.full_name : (data.data && data.data.user ? data.data.user.full_name : null);
                if (fullName) {
                    localStorage.setItem('user_name', fullName);
                }
                
                window.electronAPI.setToken(token);
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