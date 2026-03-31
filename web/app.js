/**
 * Language Exam Practice App
 * Single-file SPA with modular architecture
 */

(function () {
    'use strict';

    // ============================================
    // Configuration
    // ============================================
    const CONFIG = {
        apiBase: '/api',
        privyAppId: null, // Set from server or use demo mode
        examSpecs: {},
        defaultExam: 'jlpt',
        defaultMode: 'official'
    };

    // ============================================
    // Concurrency Helper (Sliding Window)
    // ============================================
    const RequestQueue = {
        queue: [],
        active: 0,
        limit: 5,

        setLimit(n) {
            this.limit = n;
            this.process();
        },

        async schedule(fn) {
            return new Promise((resolve, reject) => {
                this.queue.push({ fn, resolve, reject });
                this.process();
            });
        },

        process() {
            if (this.active >= this.limit || this.queue.length === 0) return;

            this.active++;
            const { fn, resolve, reject } = this.queue.shift();

            fn().then(resolve)
                .catch(reject)
                .finally(() => {
                    this.active--;
                    this.process();
                });
        },

        clear() {
            // Reject all pending (unstarted) queue items
            const pending = this.queue.splice(0);
            pending.forEach(({ reject }) => {
                try { reject(new Error('Queue cleared')); } catch (_) { }
            });
        }
    };

    // ============================================
    // State Management
    // ============================================
    const State = {
        user: null,
        userData: null,
        currentExam: 'jlpt',
        currentMode: 'official',
        currentSection: 'full',
        examSpec: null,
        test: null,
        answers: {},
        currentGroupIndex: 0,
        currentMondaiIndex: 0,
        timers: {
            overall: 0,
            group: 0
        },
        timerIntervals: {
            overall: null,
            group: null
        },
        isTestPaused: false,
        feedback: null,
        ttsAudio: null
    };

    // ============================================
    // Centralized App State Reset
    // ============================================
    function resetAppState(reason = 'unknown') {
        console.log('resetAppState called:', reason);

        // 1. Stop audio/TTS (safe if not defined yet)
        if (typeof TTSManager !== 'undefined' && TTSManager.stop) {
            try { TTSManager.stop(); } catch (_) { }
        }
        if ('speechSynthesis' in window) {
            try { speechSynthesis.cancel(); } catch (_) { }
        }

        // 2. Stop all timers
        if (typeof Timer !== 'undefined' && Timer.stopAll) {
            try { Timer.stopAll(); } catch (_) { }
        }

        // 2b. Drain pending chunk prefetch queue
        if (typeof RequestQueue !== 'undefined' && RequestQueue.clear) {
            try { RequestQueue.clear(); } catch (_) { }
        }

        // 3. Reset TestUI flags (safe if not defined yet)
        if (typeof TestUI !== 'undefined') {
            TestUI.isSubmitting = false;
            TestUI.isStartingTest = false;
            TestUI.pendingGroups = [];
            TestUI.loadingGroupIndex = 0;
            if (TestUI.progressInterval) {
                clearInterval(TestUI.progressInterval);
                TestUI.progressInterval = null;
            }
        }

        // 4. Reset State to initial values (safe null checks)
        State.user = null;
        State.userData = null;
        State.examSpec = null;
        State.test = null;
        State.answers = {};
        State.currentGroupIndex = 0;
        State.currentMondaiIndex = 0;
        State.currentInstanceKey = null;
        State.timers = { overall: 0, group: 0 };
        State.timerIntervals = { overall: null, group: null };
        State.isTestPaused = false;
        State.feedback = null;
        State.ttsAudio = null;

        // 5. Clear runtime localStorage (NOT settings/preferences)
        const sessionKeys = ['user', 'app_session_id', 'demo_userData'];
        sessionKeys.forEach(key => {
            try { localStorage.removeItem(key); } catch (_) { }
        });

        // 6. Reset UI to login screen
        showScreen('login-screen');

        // 7. Re-enable login buttons
        const demoBtn = document.querySelector('#btn-demo-login');
        if (demoBtn) {
            demoBtn.disabled = false;
            demoBtn.innerHTML = '<i class="fa-solid fa-play"></i> Vào Demo';
        }
        const emailBtn = document.querySelector('#btn-email-login');
        if (emailBtn) {
            emailBtn.disabled = false;
        }

        // 8. Hide any loading overlays
        const loader = document.querySelector('#fullscreen-loader');
        if (loader) {
            loader.classList.add('hidden');
        }
    }

    // ============================================
    // DOM References
    // ============================================
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    // ============================================
    // Screen Management
    // ============================================
    function showScreen(screenId) {
        $$('.screen').forEach(s => s.classList.remove('active'));
        const screen = $(`#${screenId}`);
        if (screen) screen.classList.add('active');
    }

    // ============================================
    // Toast Notifications
    // ============================================
    function showToast(message, type = 'info') {
        const container = $('#toast-container');
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        container.appendChild(toast);

        setTimeout(() => {
            toast.remove();
        }, 4000);
    }

    // ============================================
    // TTS Language Detection
    // ============================================
    function getExamLanguage(examId) {
        if (!examId) return 'ja-JP'; // default
        const id = examId.toLowerCase();
        if (id.includes('jlpt') || id.includes('nat')) return 'ja-JP';
        if (id.includes('hsk') || id.includes('yct')) return 'zh-CN';
        if (id.includes('ielts') || id.includes('toeic') || id.includes('toefl')) return 'en-US';
        return 'ja-JP'; // fallback
    }

    // ============================================
    // API Client
    // ============================================
    const Api = {
        async request(endpoint, options = {}) {
            const headers = {
                'Content-Type': 'application/json',
                ...(State.user?.token ? { 'Authorization': `Bearer ${State.user.token}` } : {})
            };

            try {
                const response = await fetch(`${CONFIG.apiBase}${endpoint}`, {
                    ...options,
                    headers: { ...headers, ...options.headers },
                    body: options.body ? JSON.stringify(options.body) : undefined
                });

                // Handle auth errors - reset app state and redirect to login
                if (response.status === 401 || response.status === 403) {
                    console.warn('Auth error:', response.status, 'resetting app state');
                    resetAppState('auth-failed');
                    throw new Error('Session expired. Please login again.');
                }

                if (!response.ok) {
                    const error = await response.json().catch(() => ({ error: response.statusText }));
                    throw new Error(error.error || 'Request failed');
                }

                if (response.headers.get('content-type')?.includes('application/json')) {
                    return response.json();
                }
                return response;
            } catch (err) {
                console.error('API Error:', err);
                throw err;
            }
        },

        async requestAdmin(endpoint, options = {}) {
            const secret = options.secret || '';
            const response = await fetch(`${CONFIG.apiBase}${endpoint}`, {
                ...options,
                headers: {
                    'Content-Type': 'application/json',
                    ...(secret ? { 'x-warmup-secret': secret } : {}),
                    ...options.headers
                },
                body: options.body ? JSON.stringify(options.body) : undefined
            });

            if (!response.ok) {
                const error = await response.json().catch(() => ({ error: response.statusText }));
                throw new Error(error.error || 'Admin request failed');
            }

            return response.json();
        },

        async getMe() {
            return this.request('/me', { method: 'POST' });
        },

        async getAdminLlmConfig(secret) {
            return this.requestAdmin('/admin/llm-config', { method: 'GET', secret });
        },

        async runAdminLlmHealthcheck(secret, tasks = ['generate', 'repair', 'explain']) {
            return this.requestAdmin('/admin/llm-healthcheck', {
                method: 'POST',
                secret,
                body: { tasks }
            });
        },

        async getUserData() {
            const sessionId = localStorage.getItem('app_session_id');
            const data = await this.request('/user-data', {
                method: 'POST',
                body: { sessionId }
            });

            // Client-side storage for Demo User
            if (State.user?.token === 'demo-token') {
                try {
                    const local = localStorage.getItem('demo_userData');
                    if (local) {
                        const parsed = JSON.parse(local);
                        // Merge local data with server response (which is mostly empty for demo)
                        return { ...data, ...parsed, sessionId: data.sessionId };
                    }
                } catch (e) {
                    console.error('Error loading demo local data:', e);
                }
            }

            if (data.sessionId) {
                localStorage.setItem('app_session_id', data.sessionId);
            }
            return data;
        },

        async saveUserData(data) {
            // Client-side storage for Demo User
            if (State.user?.token === 'demo-token') {
                // Save the FULL current state, as 'data' might be partial
                if (State.userData) {
                    localStorage.setItem('demo_userData', JSON.stringify(State.userData));
                }
            }
            return this.request('/user-data', { method: 'PUT', body: data });
        },

        async gradeTest(test, answers, provider, model = null, instanceKey = null) {
            // Set 300s timeout for grading
            const controller = new AbortController();
            const id = setTimeout(() => controller.abort(), 300000);

            try {
                const body = { test, answers, provider, model };
                if (instanceKey) body.instanceKey = instanceKey;

                const res = await this.request('/grade-test', {
                    method: 'POST',
                    body,
                    signal: controller.signal
                });
                clearTimeout(id);
                return res;
            } catch (err) {
                clearTimeout(id);
                if (err.name === 'AbortError') {
                    throw new Error('Chấm điểm quá lâu (timeout). Vui lòng thử lại.');
                }
                throw err;
            }
        },

        async prepareTtsText(text, language, provider) {
            return this.request('/prepare-tts-text', {
                method: 'POST',
                body: { text, language, provider }
            });
        },

        async getTts(text, language, provider, speed = 1.0, voice = null) {
            const response = await fetch(`${CONFIG.apiBase}/tts`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(State.user?.token ? { 'Authorization': `Bearer ${State.user.token}` } : {})
                },
                body: JSON.stringify({ text, language, provider, speed, voice })
            });

            if (!response.ok) {
                throw new Error('TTS generation failed');
            }

            return response.blob();
        },

        // ============ V2 API (Pool Architecture) ============
        async startExamV2(examSpec, mode, setNo) {
            return this.request('/exam/start', {
                method: 'POST',
                body: { examSpec, mode, setNo }
            });
        },

        async fetchExamChunk(instanceKey, group_id, want_count = 3) {
            return this.request('/exam/chunk', {
                method: 'POST',
                body: {
                    instanceKey,
                    want: { group_id, want_count }
                }
            });
        },

        async quickGradeV2(instanceKey, answers) {
            return this.request('/exam/quickgrade', {
                method: 'POST',
                body: { instanceKey, answers }
            });
        },

        async saveToNotebook(question, note = '', tags = []) {
            // Client-side storage for Demo User
            if (State.user?.token === 'demo-token') {
                try {
                    const local = localStorage.getItem('demo_notebook') || '[]';
                    const notebook = JSON.parse(local);
                    // Generate local ID
                    const id = question.id || 'demo_' + Date.now();
                    const entry = {
                        question_hash: id,
                        note,
                        tags,
                        created_at: new Date().toISOString(),
                        question: question,
                        hash: id, // Mimic server response
                        content: question // Mimic joined query
                    };

                    // Simple dedupe by hash/id (remove old if exists)
                    const idx = notebook.findIndex(n => n.question_hash === id);
                    if (idx >= 0) notebook.splice(idx, 1);

                    notebook.unshift(entry);
                    localStorage.setItem('demo_notebook', JSON.stringify(notebook));
                    return { success: true, hash: id };
                } catch (e) {
                    console.error('Error saving demo notebook:', e);
                    throw e;
                }
            }

            const token = State.user?.token || 'demo-token';
            const res = await fetch('/api/notebook', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ question, note, tags })
            });
            if (!res.ok) throw new Error('Failed to save to notebook');
            return await res.json();
        },

        async removeFromNotebook(question) {
            // Client-side storage for Demo User
            if (State.user?.token === 'demo-token') {
                try {
                    const local = localStorage.getItem('demo_notebook') || '[]';
                    let notebook = JSON.parse(local);
                    const id = question.hash || question.question_hash || question.id;
                    notebook = notebook.filter(n => n.question_hash !== id && n.hash !== id);
                    localStorage.setItem('demo_notebook', JSON.stringify(notebook));
                    return { success: true };
                } catch (e) { console.error('Error removing demo notebook:', e); }
            }

            const token = State.user?.token || 'demo-token';
            const res = await fetch('/api/notebook', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ question, action: 'remove' })
            });
            if (!res.ok) throw new Error('Failed to remove from notebook');
            return await res.json();
        },

        async getNotebook() {
            // Client-side storage for Demo User
            if (State.user?.token === 'demo-token') {
                try {
                    const local = localStorage.getItem('demo_notebook') || '[]';
                    return { items: JSON.parse(local) };
                } catch (e) { return { items: [] }; }
            }

            const token = State.user?.token || 'demo-token';
            const res = await fetch('/api/notebook', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!res.ok) throw new Error('Failed to fetch notebook');
            return await res.json();
        }
    };

    // ============================================
    // Auth Module (Privy SDK Integration)
    // ============================================
    const Auth = {
        privy: null,
        pendingEmail: null,

        async init() {
            // Get Privy config from server first
            let config = { privyAppId: 'demo-app-id' };
            try {
                const configRes = await fetch('/api/config');
                config = await configRes.json();
                // console.log('Privy config loaded'); // Security: Do not log config object
            } catch (err) {
                console.error('Failed to load config:', err);
            }

            // Only try to initialize Privy SDK if configured
            if (config.privyAppId && config.privyAppId !== 'demo-app-id') {
                console.log('Initializing Privy SDK...');
                try {
                    // Use bundled Privy SDK from main.js
                    const { Privy, LocalStorage } = window.PrivySDK || {};

                    if (!Privy) {
                        throw new Error('Privy SDK not loaded. Make sure to run via Vite.');
                    }

                    this.privy = new Privy({
                        appId: config.privyAppId,
                        clientId: config.privyClientId,
                        storage: LocalStorage ? new LocalStorage() : undefined
                    });
                    console.log('Privy SDK initialized successfully');
                    console.log('Privy.auth methods:', this.privy.auth ? Object.keys(this.privy.auth) : 'none');
                } catch (err) {
                    console.error('Privy SDK init failed:', err);
                    showToast('Không thể khởi tạo Privy. Sử dụng chế độ demo.', 'warning');
                    this.privy = null;
                }
            } else {
                console.log('Privy not configured, using demo mode');
            }

            // Check for saved demo session
            const savedUser = localStorage.getItem('user');
            if (savedUser) {
                try {
                    const user = JSON.parse(savedUser);
                    await this.handleAuthSuccess(user, true);
                    return;
                } catch (e) {
                    localStorage.removeItem('user');
                }
            }
        },

        showAuthLoading(message) {
            const loader = $('#fullscreen-loader');
            const loaderText = $('#fullscreen-loader-text');
            if (loader && loaderText) {
                loader.classList.remove('hidden');
                loaderText.textContent = message || 'Đang tải...';
            }
        },

        hideAuthLoading() {
            const loader = $('#fullscreen-loader');
            if (loader) loader.classList.add('hidden');
        },

        async loginWithEmail() {
            if (this.privy) {
                // Show email modal
                this.showEmailModal();
            } else {
                // Demo mode - direct login
                this.handleAuthSuccess({ email: 'demo@example.com', token: 'demo-token' });
            }
        },

        showEmailModal() {
            const modal = $('#email-modal');
            const input = $('#email-input');
            const error = $('#email-error');

            modal.classList.remove('hidden');
            input.value = '';
            error.classList.add('hidden');
            input.focus();

            // Set up handlers
            $('#btn-send-otp').onclick = async () => {
                const email = input.value.trim();
                if (!email || !email.includes('@')) {
                    error.textContent = 'Vui lòng nhập email hợp lệ';
                    error.classList.remove('hidden');
                    return;
                }

                try {
                    $('#btn-send-otp').disabled = true;
                    $('#btn-send-otp').textContent = 'Đang gửi...';

                    await this.privy.auth.email.sendCode(email);
                    this.pendingEmail = email;
                    modal.classList.add('hidden');
                    this.showOTPModal(email);
                } catch (err) {
                    error.textContent = 'Không thể gửi OTP: ' + err.message;
                    error.classList.remove('hidden');
                } finally {
                    $('#btn-send-otp').disabled = false;
                    $('#btn-send-otp').textContent = 'Gửi mã OTP';
                }
            };

            $('#btn-cancel-email').onclick = () => {
                modal.classList.add('hidden');
            };
        },

        showOTPModal(email) {
            const modal = $('#otp-modal');
            const input = $('#otp-input');
            const error = $('#otp-error');
            const display = $('#otp-email-display');

            modal.classList.remove('hidden');
            display.textContent = `Nhập mã OTP đã gửi đến ${email}`;
            input.value = '';
            error.classList.add('hidden');
            input.focus();

            // Set up handlers
            $('#btn-verify-otp').onclick = async () => {
                const code = input.value.trim();
                if (!code || code.length !== 6) {
                    error.textContent = 'Vui lòng nhập mã 6 số';
                    error.classList.remove('hidden');
                    return;
                }

                try {
                    $('#btn-verify-otp').disabled = true;
                    $('#btn-verify-otp').textContent = 'Đang xác thực...';
                    this.showAuthLoading('Đang xác thực OTP...');

                    const session = await this.privy.auth.email.loginWithCode(this.pendingEmail, code);
                    modal.classList.add('hidden');
                    await this.handlePrivySession(session);
                } catch (err) {
                    this.hideAuthLoading();
                    error.textContent = 'Mã OTP không đúng hoặc đã hết hạn';
                    error.classList.remove('hidden');
                } finally {
                    $('#btn-verify-otp').disabled = false;
                    $('#btn-verify-otp').textContent = 'Xác nhận';
                }
            };

            $('#btn-cancel-otp').onclick = () => {
                modal.classList.add('hidden');
                this.pendingEmail = null;
            };
        },

        async handlePrivySession(session) {
            console.log('Privy session received:', session);

            try {
                // Extract user info from session
                const user = session.user;
                const accessToken = session.token || session.privy_access_token;

                // Get email from linked_accounts
                const emailAccount = user.linked_accounts?.find(acc => acc.type === 'email');
                const email = emailAccount?.address || user.email?.address || 'user@privy.io';

                State.user = {
                    email: email,
                    token: accessToken,
                    privyUser: user
                };

                console.log('User logged in:', State.user.email);

                localStorage.setItem('user', JSON.stringify({
                    email: State.user.email,
                    token: State.user.token
                }));

                await this.loadUserData();
                this.updateUI();
                showScreen('home-screen');
            } finally {
                this.hideAuthLoading();
            }
        },

        async loginDemo() {
            return this.handleAuthSuccess({ email: 'demo@example.com', token: 'demo-token' });
        },

        async handleAuthSuccess(user, isRestore = false) {
            this.showAuthLoading(isRestore ? 'Đang khôi phục phiên...' : 'Đang đăng nhập...');

            try {
                State.user = {
                    email: user.email || 'demo@example.com',
                    token: user.token || 'demo-token'
                };

                localStorage.setItem('user', JSON.stringify(State.user));

                await this.loadUserData();
                this.updateUI();
                showScreen('home-screen');
            } finally {
                this.hideAuthLoading();
            }
        },

        async loadUserData() {
            try {
                const meData = await Api.getMe();
                State.user.userId = meData.userId;
                State.user.email = meData.email;

                State.userData = await Api.getUserData();

                // Check nickname (Skip for demo user)
                if (State.userData && State.userData.nickname === null && State.user.token !== 'demo-token') {
                    this.showNicknameModal();
                }

                // Apply saved settings
                if (State.userData?.settings) {
                    $('#llm-provider').value = State.userData.settings.llmProvider || 'gemini';
                    $('#tts-mode').value = State.userData.settings.ttsMode || 'auto';
                }
            } catch (err) {
                console.error('Load user data error:', err);
            }
        },

        showNicknameModal() {
            const modal = $('#nickname-modal');
            const input = $('#nickname-input');
            const btnSave = $('#btn-save-nickname');
            const btnSkip = $('#btn-skip-nickname');

            modal.classList.remove('hidden');

            const saveNickname = async (name) => {
                try {
                    State.userData.nickname = name;
                    await Api.saveUserData({ nickname: name });
                    this.updateUI();
                    modal.classList.add('hidden');
                } catch (err) {
                    console.error('Save nickname error:', err);
                    showToast('Lỗi lưu biệt danh', 'error');
                }
            };

            btnSave.onclick = () => {
                const name = input.value.trim();
                if (name) saveNickname(name);
            };

            btnSkip.onclick = () => {
                saveNickname(State.user.email);
            };
        },

        async logout() {
            resetAppState('logout');

            if (this.privy) {
                try {
                    await this.privy.auth.logout();
                } catch (e) {
                    // Expected if session already expired or user logged out elsewhere
                    console.log('Privy session cleanup:', e.message || 'already logged out');
                }
            }
        },

        updateUI() {
            if (State.user) {
                $('#user-email').textContent = State.user.email;

                // Update last activity
                if (State.userData?.history?.length > 0) {
                    const last = State.userData.history[State.userData.history.length - 1];
                    const date = new Date(last.date).toLocaleDateString('vi-VN');
                    $('#last-activity').textContent = `Lần cuối: ${last.exam} - ${date}`;
                } else {
                    $('#last-activity').textContent = 'Chưa có lịch sử làm bài';
                }
            }
        }
    };

    // ============================================
    // Exam Loader
    // ============================================
    const ExamLoader = {
        async loadSpec(examType, level) {
            // Load base spec for the exam type (e.g., "jlpt" -> "jlpt_base.json")
            const specKey = `${examType}_${level}`;
            if (CONFIG.examSpecs[specKey]) {
                return CONFIG.examSpecs[specKey];
            }

            try {
                const response = await fetch(`/exams/${examType}_base.json`);
                if (!response.ok) throw new Error('Exam spec not found');

                const baseSpec = await response.json();

                // Inject the selected level
                const spec = {
                    ...baseSpec,
                    exam_id: specKey,
                    level: level,
                    display_name_vi: `${baseSpec.display_name_vi} ${level}`
                };

                CONFIG.examSpecs[specKey] = spec;
                return spec;
            } catch (err) {
                console.error('Failed to load exam spec:', err);
                throw err;
            }
        },

        applyModeScaling(spec, mode) {
            const modeConfig = spec.modes[mode];
            const scaledSpec = JSON.parse(JSON.stringify(spec));

            // Scale time limits
            scaledSpec.scaled_time_limits = {
                overall_sec: Math.round(spec.official_time_limits_sec.overall_time_sec * modeConfig.time_scale),
                groups: spec.official_time_limits_sec.groups.map(g => ({
                    group_id: g.group_id,
                    time_sec: Math.round(g.time_sec * modeConfig.time_scale)
                }))
            };

            // Scale question counts
            scaledSpec.groups.forEach(group => {
                group.mondai.forEach(mondai => {
                    mondai.scaled_count = Math.max(1, Math.round(mondai.count_official * modeConfig.question_scale));
                });
            });

            return scaledSpec;
        },

        filterBySection(spec, section, mode = 'standard') {
            if (section === 'full') return spec;

            const filteredSpec = JSON.parse(JSON.stringify(spec));

            // Define section to mondai mapping
            const sectionMondaiMap = {
                'vocab-grammar': ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'],
                'reading': ['M8', 'M9', 'M10', 'M11', 'M12'],
                'listening': ['L1', 'L2', 'L3', 'L4', 'L5']
            };

            let allowedMondai = sectionMondaiMap[section] || [];

            // For reading section: randomly select mondai based on mode
            if (section === 'reading') {
                const readingMondai = ['M8', 'M9', 'M10', 'M11', 'M12'];
                let mondaiCount;

                switch (mode) {
                    case 'basic':
                        mondaiCount = Math.floor(Math.random() * 2) + 1; // 1-2
                        break;
                    case 'standard':
                        mondaiCount = Math.floor(Math.random() * 2) + 3; // 3-4
                        break;
                    case 'official':
                    default:
                        mondaiCount = readingMondai.length; // All 5
                        break;
                }

                // Shuffle and pick random mondai
                const shuffled = [...readingMondai].sort(() => Math.random() - 0.5);
                allowedMondai = shuffled.slice(0, mondaiCount);
                console.log(`Reading mode ${mode}: selected ${mondaiCount} mondai:`, allowedMondai);
            }

            // Filter groups based on section
            if (section === 'listening') {
                // Only keep listening group
                filteredSpec.groups = filteredSpec.groups.filter(g => g.group_id === 'listening');
                // Recalculate time limits
                const listeningTime = spec.official_time_limits_sec.groups.find(g => g.group_id === 'listening');
                if (filteredSpec.scaled_time_limits) {
                    filteredSpec.scaled_time_limits.overall_sec = filteredSpec.scaled_time_limits.groups.find(g => g.group_id === 'listening')?.time_sec || 3000;
                    filteredSpec.scaled_time_limits.groups = filteredSpec.scaled_time_limits.groups.filter(g => g.group_id === 'listening');
                }
            } else {
                // Only keep main group for vocab-grammar and reading
                filteredSpec.groups = filteredSpec.groups.filter(g => g.group_id === 'main');
                // Filter mondai within main group
                filteredSpec.groups.forEach(group => {
                    group.mondai = group.mondai.filter(m => allowedMondai.includes(m.mondai_id));
                });
                // Recalculate time limits based on remaining mondai
                if (filteredSpec.scaled_time_limits) {
                    const totalMondai = filteredSpec.groups.reduce((sum, g) => sum + g.mondai.length, 0);
                    const originalMainMondai = spec.groups.find(g => g.group_id === 'main')?.mondai.length || 12;
                    const ratio = totalMondai / originalMainMondai;
                    const mainTime = filteredSpec.scaled_time_limits.groups.find(g => g.group_id === 'main');
                    if (mainTime) {
                        mainTime.time_sec = Math.round(mainTime.time_sec * ratio);
                        filteredSpec.scaled_time_limits.overall_sec = mainTime.time_sec;
                    }
                    filteredSpec.scaled_time_limits.groups = filteredSpec.scaled_time_limits.groups.filter(g => g.group_id === 'main');
                }
            }

            return filteredSpec;
        },

        getTotalMondai(spec) {
            return spec.groups.reduce((sum, g) => sum + g.mondai.length, 0);
        },

        getMondaiByIndex(spec, globalIndex) {
            let idx = 0;
            for (const group of spec.groups) {
                for (const mondai of group.mondai) {
                    if (idx === globalIndex) {
                        return { group, mondai };
                    }
                    idx++;
                }
            }
            return null;
        },

        getGlobalMondaiIndex(spec, groupId, mondaiId) {
            let idx = 0;
            for (const group of spec.groups) {
                for (const mondai of group.mondai) {
                    if (group.group_id === groupId && mondai.mondai_id === mondaiId) {
                        return idx;
                    }
                    idx++;
                }
            }
            return 0;
        }
    };

    // ============================================
    // Timer Module
    // ============================================
    const Timer = {
        formatTime(seconds) {
            const mins = Math.floor(seconds / 60);
            const secs = seconds % 60;
            return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        },

        startOverallTimer(totalSeconds) {
            State.timers.overall = totalSeconds;
            this.updateOverallDisplay();

            if (State.timerIntervals.overall) {
                clearInterval(State.timerIntervals.overall);
            }

            State.timerIntervals.overall = setInterval(() => {
                if (State.isTestPaused) return;

                State.timers.overall--;
                this.updateOverallDisplay();

                if (State.timers.overall <= 0) {
                    this.onOverallTimeUp();
                }
            }, 1000);
        },

        startGroupTimer(totalSeconds) {
            State.timers.group = totalSeconds;
            this.updateGroupDisplay();

            if (State.timerIntervals.group) {
                clearInterval(State.timerIntervals.group);
            }

            State.timerIntervals.group = setInterval(() => {
                if (State.isTestPaused) return;

                State.timers.group--;
                this.updateGroupDisplay();

                if (State.timers.group <= 0) {
                    this.onGroupTimeUp();
                }
            }, 1000);
        },

        updateOverallDisplay() {
            const el = $('#overall-time');
            el.textContent = this.formatTime(State.timers.overall);

            const timerEl = el.closest('.timer');
            timerEl.classList.remove('warning', 'danger');

            if (State.timers.overall <= 60) {
                timerEl.classList.add('danger');
            } else if (State.timers.overall <= 300) {
                timerEl.classList.add('warning');
            }
        },

        updateGroupDisplay() {
            const el = $('#group-time');
            el.textContent = this.formatTime(State.timers.group);

            const timerEl = el.closest('.timer');
            timerEl.classList.remove('warning', 'danger');

            if (State.timers.group <= 30) {
                timerEl.classList.add('danger');
            } else if (State.timers.group <= 120) {
                timerEl.classList.add('warning');
            }
        },

        onOverallTimeUp() {
            clearInterval(State.timerIntervals.overall);
            clearInterval(State.timerIntervals.group);
            showToast('Hết giờ! Bài thi đã được nộp tự động.', 'warning');
            TestUI.submitTest();
        },

        onGroupTimeUp() {
            clearInterval(State.timerIntervals.group);
            const currentGroupIdx = State.currentGroupIndex;
            const totalGroups = State.examSpec.groups.length;

            if (currentGroupIdx < totalGroups - 1) {
                showToast('Hết giờ phần này! Chuyển sang phần tiếp theo.', 'warning');
                TestUI.moveToNextGroup();
            } else {
                showToast('Hết giờ! Bài thi đã được nộp tự động.', 'warning');
                TestUI.submitTest();
            }
        },

        stopAll() {
            if (State.timerIntervals.overall) {
                clearInterval(State.timerIntervals.overall);
                State.timerIntervals.overall = null;
            }
            if (State.timerIntervals.group) {
                clearInterval(State.timerIntervals.group);
                State.timerIntervals.group = null;
            }
        },

        togglePause(isPaused) {
            // Timer already handles pause via State.isTestPaused check in intervals
            // This method exists for explicit pause control if needed
            State.isTestPaused = isPaused;
        }
    };

    // ============================================
    // TTS Manager
    // ============================================
    // FNV-1a 32-bit hash for deterministic audio keys
    function fnv1a32(str) {
        let h = 0x811c9dc5;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
        }
        return (h >>> 0).toString(16).padStart(8, '0');
    }

    const TTSManager = {
        audioQueue: [],      // Queue of audio blobs to play
        isPlaying: false,    // Currently playing audio
        isPaused: false,     // Pause state for streaming
        currentIndex: 0,     // Current segment index
        totalSegments: 0,    // Total segments expected
        combinedBlob: null,  // Combined audio for seek/timer (hybrid mode)
        clientCache: new Map(), // Client-side TTS cache (non-dialogue)
        currentAudioKey: null,  // Key for current mondai audio session (legacy)
        abortController: null,  // AbortController for fetch requests (legacy)

        // NEW: Session-level audio cache for mondai switching
        activeKey: null,           // Current active mondai audio key
        audioCache: new Map(),     // Map<audioKey, { blob, url, duration, lastTime, completed }>
        streamAbortController: null, // AbortController for streaming TTS

        // Get deterministic audio key for a mondai
        getAudioKey(scriptText, lang, mondaiId = null) {
            if (mondaiId) {
                return `${lang}|${mondaiId}|${fnv1a32(scriptText)}`;
            }
            return `${lang}|${fnv1a32(scriptText)}`;
        },

        // Persist current playback progress to cache before switching mondai
        persistProgress() {
            if (this.activeKey && State.ttsAudio && this.audioCache.has(this.activeKey)) {
                const entry = this.audioCache.get(this.activeKey);
                entry.lastTime = State.ttsAudio.currentTime || 0;
                entry.completed = State.ttsAudio.ended || false;
                console.log('TTS: Persisted progress for', this.activeKey, 'at', entry.lastTime);
            }
        },

        // Load audio from cache if available, returns true if loaded
        loadFromCacheIfAny(audioKey) {
            if (!this.audioCache.has(audioKey)) {
                console.log('TTS: Cache miss for', audioKey);
                return false;
            }

            const entry = this.audioCache.get(audioKey);
            console.log('TTS: Cache hit for', audioKey, 'duration:', entry.duration);

            // Create new Audio from cached blob URL
            if (State.ttsAudio) {
                State.ttsAudio.pause();
                // Don't revoke cached URLs
            }

            State.ttsAudio = new Audio(entry.url);
            this.combinedBlob = entry.blob;
            this.activeKey = audioKey;

            // Setup combined audio UI (timer/seek)
            this.setupCombinedAudio();

            // Reset progress to 0 (or resume from lastTime if desired)
            State.ttsAudio.currentTime = 0; // Always reset for clean UX
            return true;
        },

        // Set active key and reset UI if key changed
        setActiveKey(audioKey) {
            if (this.activeKey !== audioKey) {
                // Persist old progress before switching
                this.persistProgress();
                this.activeKey = audioKey;
                console.log('TTS: Active key set to', audioKey);
            }
        },

        // Stop runtime playback but preserve cache
        stopRuntimeOnly() {
            // Abort any ongoing stream
            if (this.streamAbortController) {
                try { this.streamAbortController.abort(); } catch (_) { }
                this.streamAbortController = null;
            }
            if (this.abortController) {
                try { this.abortController.abort(); } catch (_) { }
                this.abortController = null;
            }

            // Stop audio but preserve cache
            this.persistProgress();
            if (State.ttsAudio) {
                State.ttsAudio.pause();
                // Don't revoke cached URLs, don't null out
            }
            State.ttsAudio = null;

            if ('speechSynthesis' in window) {
                speechSynthesis.cancel();
            }

            // Clear streaming state
            this.audioQueue = [];
            this.isPlaying = false;
            this.isPaused = false;
            this.currentIndex = 0;
            this.combinedBlob = null;
            // Keep activeKey and audioCache intact
        },

        // Reset audio player UI to idle state
        resetPlayerUI() {
            const timeEl = $('#audio-time');
            if (timeEl) timeEl.textContent = '--:-- / --:--';
            const seek = $('#audio-seek');
            if (seek) {
                seek.value = 0;
                seek.disabled = true;
            }
        },

        // Simple hash for client cache
        hashText(text) {
            let hash = 0;
            for (let i = 0; i < text.length; i++) {
                const char = text.charCodeAt(i);
                hash = ((hash << 5) - hash) + char;
                hash = hash & hash;
            }
            return hash.toString(16);
        },

        // Detect dialogue format (Speaker: text)
        isDialogue(text) {
            const dialoguePattern = /^([A-Za-z0-9\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff_]+)\s*[:：]\s*.+$/gm;
            const matches = text.match(dialoguePattern);
            return matches && matches.length >= 2;
        },

        async playAudio(text, language, audioKey = null) {
            const ttsMode = $('#tts-mode').value;
            const statusEl = $('#audio-status');

            // Create deterministic audioKey if not provided
            const newAudioKey = audioKey || `${language}|${fnv1a32(text)}`;

            // If key changed, stop old session and start new one
            if (this.currentAudioKey && this.currentAudioKey !== newAudioKey) {
                console.log('TTS: Audio key changed, stopping old session', {
                    old: this.currentAudioKey,
                    new: newAudioKey
                });
                this.stop();
            }

            // Set current key
            this.currentAudioKey = newAudioKey;

            try {
                statusEl.textContent = 'Đang tải...';

                if (ttsMode === 'browser') {
                    await this.playBrowserTTS(text, language);
                } else {
                    const provider = ttsMode === 'auto' ? 'deepgram' : ttsMode;
                    const textIsDialogue = this.isDialogue(text);

                    // Check client cache first (for non-dialogue)
                    const cacheKey = this.hashText(text + language);
                    if (!textIsDialogue && this.clientCache.has(cacheKey)) {
                        console.log('TTS: Client cache hit');
                        statusEl.textContent = '';
                        await this.playBlob(this.clientCache.get(cacheKey));
                        return;
                    }

                    try {
                        if (textIsDialogue) {
                            // Dialogue: use streaming + hybrid combine
                            console.log('TTS: Dialogue mode → streaming');
                            await this.playStreamingTTS(text, language, provider);
                        } else {
                            // Non-dialogue: use regular endpoint (server cached)
                            console.log('TTS: Non-dialogue mode → regular endpoint');
                            const blob = await Api.getTts(text, language, provider);

                            // Cache on client
                            this.clientCache.set(cacheKey, blob);
                            // Limit cache size
                            if (this.clientCache.size > 20) {
                                const oldestKey = this.clientCache.keys().next().value;
                                this.clientCache.delete(oldestKey);
                            }

                            await this.playBlob(blob);
                        }
                    } catch (err) {
                        console.warn('TTS failed, falling back to browser:', err);
                        await this.playBrowserTTS(text, language);
                    }
                }

                statusEl.textContent = '';
            } catch (err) {
                statusEl.textContent = 'Lỗi phát âm thanh';
                showToast('Không thể phát âm thanh: ' + err.message, 'error');
            }
        },

        // Streaming TTS using SSE - plays audio as segments arrive
        async playStreamingTTS(text, language, provider) {
            // Capture the active key at start to guard against late events
            const streamKey = this.activeKey;

            return new Promise((resolve, reject) => {
                this.audioQueue = [];
                this.currentIndex = 0;
                this.totalSegments = 0;
                this.isPlaying = false;

                const statusEl = $('#audio-status');

                // Create abort controller for this stream
                this.streamAbortController = new AbortController();
                const signal = this.streamAbortController.signal;

                // Create EventSource-like connection using fetch with abort signal
                fetch(`${CONFIG.apiBase}/tts/stream`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(State.user?.token ? { 'Authorization': `Bearer ${State.user.token}` } : {})
                    },
                    body: JSON.stringify({ text, language, provider }),
                    signal
                }).then(response => {
                    if (!response.ok) {
                        throw new Error('Streaming TTS request failed');
                    }

                    const reader = response.body.getReader();
                    const decoder = new TextDecoder();
                    let buffer = '';

                    const processStream = async () => {
                        try {
                            while (true) {
                                const { done, value } = await reader.read();
                                if (done) break;

                                // Late event guard: if key changed, abort silently
                                if (this.activeKey !== streamKey) {
                                    console.log('TTS: Stream key mismatch, ignoring late events');
                                    return resolve();
                                }

                                buffer += decoder.decode(value, { stream: true });
                                const lines = buffer.split('\n\n');
                                buffer = lines.pop() || '';

                                for (const line of lines) {
                                    if (line.startsWith('data: ')) {
                                        const data = JSON.parse(line.slice(6));
                                        await this.handleStreamEvent(data, statusEl, resolve, reject, streamKey);
                                    }
                                }
                            }
                        } catch (err) {
                            if (err.name === 'AbortError') {
                                console.log('TTS: Stream aborted');
                                return resolve();
                            }
                            reject(err);
                        }
                    };

                    processStream();
                }).catch(err => {
                    if (err.name === 'AbortError') {
                        console.log('TTS: Fetch aborted');
                        return resolve();
                    }
                    reject(err);
                });
            });
        },

        async handleStreamEvent(data, statusEl, resolve, reject, streamKey) {
            // Late event guard
            if (streamKey && this.activeKey !== streamKey) {
                console.log('TTS: Ignoring late stream event for', streamKey);
                return;
            }

            switch (data.type) {
                case 'info':
                    this.totalSegments = data.total;
                    statusEl.textContent = 'Đang tải...';
                    break;

                case 'audio':
                    // Convert base64 to blob
                    const audioData = atob(data.audio);
                    const audioArray = new Uint8Array(audioData.length);
                    for (let i = 0; i < audioData.length; i++) {
                        audioArray[i] = audioData.charCodeAt(i);
                    }
                    const blob = new Blob([audioArray], { type: 'audio/mpeg' });

                    this.audioQueue.push(blob);
                    // Keep simple loading text
                    if (!this.isPlaying) {
                        statusEl.textContent = 'Đang tải...';
                    }

                    // Start playing immediately when first segment arrives
                    if (!this.isPlaying && this.audioQueue.length === 1) {
                        this.isPlaying = true;
                        statusEl.textContent = 'Đang phát...';
                        this.playNextInQueue(resolve, reject, streamKey);
                    }
                    break;

                case 'done':
                    // All segments received - combine for seek/timer support
                    if (this.audioQueue.length > 0) {
                        this.combinedBlob = new Blob(this.audioQueue, { type: 'audio/mpeg' });
                        console.log('TTS: Combined blob created for seek/timer');

                        // Cache the combined audio for this mondai
                        if (this.activeKey) {
                            const url = URL.createObjectURL(this.combinedBlob);
                            this.audioCache.set(this.activeKey, {
                                blob: this.combinedBlob,
                                url,
                                duration: 0, // Will be set when metadata loads
                                lastTime: 0,
                                completed: false
                            });
                            console.log('TTS: Cached combined audio for', this.activeKey);

                            // LRU eviction if cache too large
                            if (this.audioCache.size > 10) {
                                const oldestKey = this.audioCache.keys().next().value;
                                const oldEntry = this.audioCache.get(oldestKey);
                                if (oldEntry?.url) URL.revokeObjectURL(oldEntry.url);
                                this.audioCache.delete(oldestKey);
                                console.log('TTS: Evicted oldest cache entry', oldestKey);
                            }
                        }
                    }
                    if (this.audioQueue.length === 0) {
                        resolve(); // No audio was generated
                    }
                    // Otherwise, playback will resolve when queue is empty
                    break;

                case 'error':
                    reject(new Error(data.message));
                    break;

                case 'segment_error':
                    console.warn(`Segment ${data.index} failed: ${data.message}`);
                    // Continue with other segments
                    break;
            }
        },

        async playNextInQueue(resolve, reject, streamKey = null) {
            // Late event guard
            if (streamKey && this.activeKey !== streamKey) {
                console.log('TTS: playNextInQueue - key mismatch, stopping');
                return resolve();
            }

            if (this.currentIndex >= this.audioQueue.length) {
                // Check if more segments are coming
                if (this.currentIndex >= this.totalSegments) {
                    this.isPlaying = false;
                    const btn = $('#btn-play-audio');
                    if (btn) btn.innerHTML = `<span class="play-icon"><i class="fa-solid fa-rotate-right"></i></span> Nghe lại`;

                    // Switch to combined blob for seek/timer support
                    if (this.combinedBlob) {
                        console.log('TTS: Switching to combined audio for seek/timer');
                        this.setupCombinedAudio();

                        // Update duration in cache
                        if (this.activeKey && this.audioCache.has(this.activeKey) && State.ttsAudio) {
                            const entry = this.audioCache.get(this.activeKey);
                            entry.duration = State.ttsAudio.duration || 0;
                        }
                    }

                    resolve();
                } else {
                    // Wait for more segments
                    setTimeout(() => this.playNextInQueue(resolve, reject, streamKey), 100);
                }
                return;
            }

            const blob = this.audioQueue[this.currentIndex];
            const url = URL.createObjectURL(blob);

            if (State.ttsAudio) {
                State.ttsAudio.pause();
                if (State.ttsAudio.src) URL.revokeObjectURL(State.ttsAudio.src);
            }

            State.ttsAudio = new Audio(url);

            State.ttsAudio.onended = () => {
                URL.revokeObjectURL(url);
                this.currentIndex++;
                this.playNextInQueue(resolve, reject);
            };

            State.ttsAudio.onerror = (err) => {
                URL.revokeObjectURL(url);
                this.currentIndex++;
                // Try next segment instead of failing completely
                this.playNextInQueue(resolve, reject);
            };

            State.ttsAudio.onplay = () => {
                const btn = $('#btn-play-audio');
                if (btn) btn.innerHTML = `<span class="play-icon"><i class="fa-solid fa-pause"></i></span> Tạm dừng`;
            };

            try {
                await State.ttsAudio.play();
            } catch (err) {
                this.currentIndex++;
                this.playNextInQueue(resolve, reject);
            }
        },

        // Stream audio chunks for immediate playback
        async playStreaming(text, language, provider, speed, voice) {
            return new Promise(async (resolve, reject) => {
                try {
                    this.stop(); // Reset state
                    this.isPlaying = true;

                    const btn = $('#btn-play-audio');
                    if (btn) btn.innerHTML = `<span class="play-icon"><i class="fa-solid fa-spinner fa-spin"></i></span> Đang tải...`;

                    const response = await fetch(`${CONFIG.apiBase}/tts/stream`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            ...(State.user?.token ? { 'Authorization': `Bearer ${State.user.token}` } : {})
                        },
                        body: JSON.stringify({ text, language })
                    });

                    if (!response.ok) throw new Error('TTS Stream Request Failed');

                    const reader = response.body.getReader();
                    const decoder = new TextDecoder();
                    let buffer = '';

                    // Start processing stream
                    this.isStreamComplete = false;

                    // UI defaults
                    const timeEl = $('#audio-time');
                    if (timeEl) timeEl.textContent = 'Đang phát';
                    const seekEl = $('#audio-seek');
                    if (seekEl) seekEl.disabled = true;

                    // Read loop
                    (async () => {
                        try {
                            while (true) {
                                const { done, value } = await reader.read();
                                if (done) {
                                    this.isStreamComplete = true;
                                    // If queue was empty and we were waiting, this triggers finish
                                    if (this.currentIndex >= this.audioQueue.length && (!State.ttsAudio || State.ttsAudio.paused)) {
                                        // check if playing, if not, finish
                                        this.playNextInQueue(resolve, reject);
                                    }
                                    break;
                                }

                                buffer += decoder.decode(value, { stream: true });
                                const lines = buffer.split('\n\n');
                                buffer = lines.pop(); // Keep incomplete chunk

                                for (const line of lines) {
                                    if (line.startsWith('data: ')) {
                                        const jsonStr = line.slice(6);
                                        try {
                                            const data = JSON.parse(jsonStr);
                                            if (data.type === 'audio' && data.audio) {
                                                // Convert base64 to blob
                                                const byteCharacters = atob(data.audio);
                                                const byteNumbers = new Array(byteCharacters.length);
                                                for (let i = 0; i < byteCharacters.length; i++) {
                                                    byteNumbers[i] = byteCharacters.charCodeAt(i);
                                                }
                                                const byteArray = new Uint8Array(byteNumbers);
                                                const blob = new Blob([byteArray], { type: 'audio/mp3' });

                                                this.audioQueue.push(blob);

                                                // If this is the FIRST chunk, start playing immediately!
                                                if (this.audioQueue.length === 1 && !State.ttsAudio) {
                                                    this.playNextInQueue(resolve, reject);
                                                    if (btn) btn.innerHTML = `<span class="play-icon"><i class="fa-solid fa-pause"></i></span> Tạm dừng`;
                                                }
                                            } else if (data.type === 'error') {
                                                console.error('Stream Error:', data.message);
                                            }
                                        } catch (e) {
                                            console.warn('JSON Parse Error in stream:', e);
                                        }
                                    }
                                }
                            }
                        } catch (err) {
                            console.error('Stream Reader Error:', err);
                            reject(err);
                        }
                    })();

                } catch (err) {
                    reject(err);
                }
            });
        },

        // Setup combined audio for seek/timer after streaming completes
        setupCombinedAudio() {
            if (!this.combinedBlob) { console.log('TPS: No combined blob'); return; }
            console.log('TPS: Setup combined audio, size:', this.combinedBlob.size);

            const url = URL.createObjectURL(this.combinedBlob);

            if (State.ttsAudio) {
                State.ttsAudio.pause();
                if (State.ttsAudio.src) URL.revokeObjectURL(State.ttsAudio.src);
            }

            State.ttsAudio = new Audio(url);
            State.ttsAudio.preload = 'metadata';

            // Setup time update for seek bar
            State.ttsAudio.ontimeupdate = () => {
                const currentTime = State.ttsAudio.currentTime;
                const duration = State.ttsAudio.duration;

                const timeEl = $('#audio-time');
                if (timeEl && !isNaN(duration)) {
                    timeEl.textContent = `${this.formatTime(currentTime)} / ${this.formatTime(duration)}`;
                }

                const seek = $('#audio-seek');
                if (seek && !isNaN(duration)) {
                    seek.value = (currentTime / duration) * 100;
                }
            };

            State.ttsAudio.onloadedmetadata = () => {
                console.log('TPS: Metadata loaded, dur:', State.ttsAudio.duration);
                const timeEl = $('#audio-time');
                if (timeEl) {
                    timeEl.textContent = `00:00 / ${this.formatTime(State.ttsAudio.duration)}`;
                }
                const seek = $('#audio-seek');
                if (seek) seek.disabled = false;
            };

            State.ttsAudio.onplay = () => {
                const btn = $('#btn-play-audio');
                if (btn) btn.innerHTML = `<span class="play-icon"><i class="fa-solid fa-pause"></i></span> Tạm dừng`;
            };
            State.ttsAudio.onpause = () => {
                const btn = $('#btn-play-audio');
                if (btn) btn.innerHTML = `<span class="play-icon"><i class="fa-solid fa-play"></i></span> Tiếp tục`;
            };
            State.ttsAudio.onended = () => {
                const btn = $('#btn-play-audio');
                if (btn) btn.innerHTML = `<span class="play-icon"><i class="fa-solid fa-rotate-left"></i></span> Nghe lại`;
            };

            // Don't auto-play - user will click "Nghe" to replay
        },



        async playBlob(blob) {
            return new Promise((resolve, reject) => {
                const url = URL.createObjectURL(blob);

                if (State.ttsAudio) {
                    State.ttsAudio.pause();
                    if (State.ttsAudio.src) URL.revokeObjectURL(State.ttsAudio.src);
                }

                State.ttsAudio = new Audio(url);

                // Time update & Seek integration
                State.ttsAudio.ontimeupdate = () => {
                    const currentTime = State.ttsAudio.currentTime;
                    const duration = State.ttsAudio.duration;

                    // Update time display
                    const timeEl = $('#audio-time');
                    if (timeEl && !isNaN(duration)) {
                        timeEl.textContent = `${this.formatTime(currentTime)} / ${this.formatTime(duration)}`;
                    }

                    // Update seek bar
                    const seek = $('#audio-seek');
                    if (seek && !isNaN(duration)) {
                        seek.value = (currentTime / duration) * 100;
                    }
                };

                State.ttsAudio.onended = () => {
                    URL.revokeObjectURL(url);
                    TTSManager.isPlaying = false;
                    const btn = $('#btn-play-audio');
                    if (btn) btn.innerHTML = `<span class="play-icon"><i class="fa-solid fa-play"></i></span> Nghe`;

                    // Reset seek
                    const seek = $('#audio-seek');
                    if (seek) seek.value = 100;
                };

                State.ttsAudio.onerror = reject;

                // Resolve promise when playback STARTS so UI is interactive
                State.ttsAudio.onplay = () => {
                    TTSManager.isPlaying = true;
                    const btn = $('#btn-play-audio');
                    if (btn) btn.innerHTML = `<span class="play-icon"><i class="fa-solid fa-pause"></i></span> Tạm dừng`;
                    resolve();
                };

                // Also resolve on canplay through to ensure we don't block
                State.ttsAudio.oncanplaythrough = () => {
                    // Optional: enable controls
                };

                State.ttsAudio.play().then(() => {
                    // Modern browsers return promise
                    // Resolve handled in onplay
                }).catch(reject);
            });
        },

        async playBrowserTTS(text, language) {
            return new Promise((resolve, reject) => {
                if (!('speechSynthesis' in window)) {
                    reject(new Error('Browser TTS not supported'));
                    return;
                }

                // Stop any existing
                speechSynthesis.cancel();

                const utterance = new SpeechSynthesisUtterance(text);
                utterance.lang = language;
                utterance.rate = 0.9;

                utterance.onstart = () => {
                    const btn = $('#btn-play-audio');
                    if (btn) btn.innerHTML = `<span class="play-icon"><i class="fa-solid fa-pause"></i></span> Tạm dừng`;
                    resolve(); // Resolve immediately
                };

                utterance.onend = () => {
                    const btn = $('#btn-play-audio');
                    if (btn) btn.innerHTML = `<span class="play-icon"><i class="fa-solid fa-play"></i></span> Nghe`;
                };

                utterance.onerror = (err) => {
                    reject(err);
                };

                speechSynthesis.speak(utterance);
            });
        },

        stop() {
            // Abort ongoing fetch requests fully
            if (this.streamAbortController) {
                try { this.streamAbortController.abort(); } catch (_) { }
                this.streamAbortController = null;
            }
            if (this.abortController) {
                try { this.abortController.abort(); } catch (_) { }
                this.abortController = null;
            }
            if (State.ttsAudio) {
                State.ttsAudio.pause();
                // Revoke src to avoid leaks, except if it's cached. But we're fully stopping.
                if (State.ttsAudio.src) URL.revokeObjectURL(State.ttsAudio.src);
                State.ttsAudio = null;
            }
            if ('speechSynthesis' in window) {
                speechSynthesis.cancel();
            }
            // Clear streaming queue and combined blob
            this.audioQueue = [];
            this.isPlaying = false;
            this.isPaused = false;
            this.currentIndex = 0;
            this.combinedBlob = null;
            this.currentAudioKey = null;
            // Reset audio timer/progress UI
            const audioTime = $('#audio-time');
            if (audioTime) audioTime.textContent = '00:00';
            const audioSeek = $('#audio-seek');
            if (audioSeek) audioSeek.value = 0;
        },

        // Helper to resume streaming safely
        handleResumeStreaming() {
            this.isPaused = false;
            this.isPlaying = true;
            if (State.ttsAudio) {
                State.ttsAudio.play().catch(e => {
                    if (e.name !== 'AbortError') console.warn(e);
                });
            }
        },

        // Toggle pause for streaming TTS
        togglePause() {
            if (!State.ttsAudio) return false;

            if (State.ttsAudio.paused) {
                State.ttsAudio.play().catch(e => {
                    // Ignore AbortError (interrupted by pause)
                    if (e.name !== 'AbortError') console.error(e);
                });
                this.isPaused = false;
                return true; // Now playing
            } else {
                State.ttsAudio.pause();
                this.isPaused = true;
                return false; // Now paused
            }
        },

        // Helper for time format (MM:SS)
        formatTime(seconds) {
            const mins = Math.floor(seconds / 60);
            const secs = Math.floor(seconds % 60);
            return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        }
    };

    // ============================================
    // Test UI
    // ============================================
    const TestUI = {
        pendingGroups: [], // Track groups being loaded in background
        loadingGroupIndex: 0, // Current group being loaded
        isSubmitting: false, // Prevent duplicate submissions
        isStartingTest: false, // Prevent duplicate test starts
        activeLoaders: new Set(),
        nextLoadFailTimer: null,
        showNextButtonRetryState: false,

        simulateProgress(bar, text) {
            if (!bar) bar = $('#loading-progress');
            if (!text) text = $('#progress-text');
            if (!bar) return;

            if (this.progressInterval) clearInterval(this.progressInterval);

            let progress = 0;
            const startTime = Date.now();
            const targetDuration = 25000; // 25 seconds to reach 98%

            this.progressInterval = setInterval(() => {
                const elapsed = Date.now() - startTime;
                // Ease-out curve: fast at start, slow near end
                const targetProgress = 98 * (1 - Math.pow(1 - Math.min(elapsed / targetDuration, 1), 2));
                progress = Math.min(Math.round(targetProgress), 98);

                bar.style.width = `${progress}%`;
                if (text) text.textContent = `${progress}%`;
            }, 200);
        },

        stopProgress() {
            if (this.progressInterval) clearInterval(this.progressInterval);
            const bar = $('#loading-progress');
            const text = $('#progress-text');
            if (bar) bar.style.width = '100%';
            if (text) text.textContent = '100%';
        },

        getMondaiKey(mondai) {
            return mondai?.slot_id || mondai?.meta?.slot_id || mondai?.mondai_id || null;
        },

        getGroupExpectedCount(groupIndex) {
            const manifestGroup = State.test?.meta?.manifest?.groups?.[groupIndex];
            if (manifestGroup?.expected_mondai_count) {
                return manifestGroup.expected_mondai_count;
            }
            return State.examSpec?.groups?.[groupIndex]?.mondai?.length || 0;
        },

        getLoadedMondaiCount(group) {
            if (!group) return 0;
            return group.order ? Object.keys(group._mondaiById || {}).length : (group.mondai || []).length;
        },

        getGroupMondaiCount(group) {
            if (!group) return 0;
            return group.order && group.order.length > 0 ? group.order.length : (group.mondai ? group.mondai.length : 0);
        },

        assignMondaiToGroup(group, mondai) {
            if (!group || !mondai) return false;
            const key = this.getMondaiKey(mondai);
            if (!key) return false;
            if (!group._mondaiById) group._mondaiById = {};
            group._mondaiById[key] = mondai;
            return true;
        },

        getOrderedMondaiList(group) {
            if (!group) return [];
            if (group.order && group.order.length > 0) {
                return group.order.map((id) => group._mondaiById?.[id]).filter(Boolean);
            }
            return group.mondai || [];
        },


        async startTest() {
            // Prevent duplicate test starts
            if (this.isStartingTest) {
                console.log('startTest already in progress, skipping');
                return;
            }
            this.isStartingTest = true;

            const llmProvider = $('#llm-provider').value;
            const targetModel = null;

            try {
                // 1. Extract UI selections
                const activeExamTab = $('.exam-tab-wrapper.active');
                if (!activeExamTab) throw new Error('Vui lòng chọn kỳ thi');

                const examType = activeExamTab.dataset.exam || 'jlpt';
                const levelSelect = examType === 'jlpt' ? '#jlpt-level' : '#hsk-level';
                const level = $(levelSelect)?.value || 'N2';

                const activeModeCard = $('.mode-card.selected');
                if (!activeModeCard) throw new Error('Vui lòng chọn chế độ thi');
                const mode = activeModeCard.dataset.mode || 'official';

                const activeSectionOption = $('.section-option.selected');
                const section = activeSectionOption?.dataset.section || 'full';

                // Update global state
                State.currentExam = examType;
                State.currentMode = mode;
                State.currentSection = section;

                console.log(`Starting test V2: ${examType} ${level}, mode: ${mode}, section: ${section}`);

                // 2. Load exam spec
                let baseSpec = await ExamLoader.loadSpec(examType, level);

                // 3. Apply mode scaling (Frontend still does this to filter spec passed to server?)
                // Actually V2 server does scaling/blueprint if we pass raw spec?
                // But server takes 'examSpec'. If we pass filtered spec, server respects it.
                // Converting spec to "Protocol" object?
                // Let's rely on frontend filtering to keep consistent behavior with existing "Section" logic.

                let scaledSpec = ExamLoader.applyModeScaling(baseSpec, mode);
                State.examSpec = ExamLoader.filterBySection(scaledSpec, section, mode);

                if (!State.examSpec) throw new Error('Không thể tải cấu hình đề thi');

                console.log('ExamSpec prepared for V2:', State.examSpec);
            } catch (err) {
                console.error('Load exam spec error:', err);
                showToast('Lỗi tải đề thi: ' + err.message, 'error');
                return;
            }

            // Show loading screen
            showScreen('loading-screen');
            $('#loading-text').textContent = 'Đang khởi tạo đề thi...';
            $('#loading-hint').textContent = 'Đang kết nối đến ngân hàng câu hỏi...';

            const progressBar = $('#loading-progress');
            const progressText = $('#progress-text');
            if (progressBar) progressBar.style.width = '30%';
            if (progressText) progressText.textContent = '30%';

            try {
                // Call V2 Start Endpoint
                const res = await Api.startExamV2(State.examSpec, State.currentMode);
                console.log('V2 Start Res:', res);

                if (progressBar) progressBar.style.width = '70%';
                if (progressText) progressText.textContent = '70%';

                // Initialize State.test from Manifest
                State.currentInstanceKey = res.instanceKey;

                State.test = {
                    meta: {
                        exam_id: State.examSpec.exam_id,
                        mode: State.currentMode,
                        start_time: new Date().toISOString(),
                        time_limits: State.examSpec.scaled_time_limits || State.examSpec.official_time_limits_sec,
                        language: getExamLanguage(State.examSpec.exam_id),
                        manifest: res.manifest  // Store manifest for processChunk/loadRemainingChunksV2
                    },
                    groups: res.manifest.groups.map(g => {
                        return {
                            group_id: g.group_id,
                            title_vi: g.title_vi,
                            order: Array.isArray(g.slot_order) ? g.slot_order : [],
                            _mondaiById: {},
                            mondai: [] // Legacy array fallback
                        };
                    })
                };

                State.answers = {};
                State.currentGroupIndex = 0;
                State.currentMondaiIndex = 0;
                State.isTestPaused = false;
                State.feedback = null;

                // Process First Chunk
                if (res.mondai && res.mondai.length > 0) {
                    this.processChunk(res.mondai);
                }

                if (progressBar) progressBar.style.width = '100%';
                if (progressText) progressText.textContent = '100%';

                this.stopProgress();
                this.isStartingTest = false; // Reset after successful start
                showScreen('test-screen');
                this.initializeTest();
                console.log('Test Initialized (V2).');

                // Start Background Loading V2
                this.loadRemainingChunksV2();

            } catch (err) {
                this.stopProgress();
                this.isStartingTest = false; // Reset on error
                console.error('Start Test V2 Error:', err);
                showToast('Lỗi khởi tạo bài thi: ' + err.message, 'error');
                showScreen('home-screen');
            }
        },

        async retryFetchNextMondai(targetGroupId) {
            if (this.activeLoaders.has(targetGroupId)) return;

            this.showNextButtonRetryState = false;
            this.updateNavigationButtons();

            this.activeLoaders.add(targetGroupId);
            try {
                const res = await Api.fetchExamChunk(State.currentInstanceKey, targetGroupId, 3);
                const group = State.test.groups.find(g => g.group_id === targetGroupId);
                if (group && res.chunk && res.chunk.length > 0) {
                    res.chunk.forEach(m => {
                        this.assignMondaiToGroup(group, m);
                    });
                    this.updateProgressUI();
                }
            } catch (err) {
                console.error('Retry fetch chunk error:', err);
                this.showNextButtonRetryState = true;
            } finally {
                this.activeLoaders.delete(targetGroupId);
                this.updateNavigationButtons();
            }
        },

        // Helper to distribute mondai to correct groups based on capacity
        processChunk(mondaiList) {
            const manifest = State.test.meta.manifest;
            if (!manifest) return;

            mondaiList.forEach(m => {
                const key = this.getMondaiKey(m);
                for (let i = 0; i < State.test.groups.length; i++) {
                    const group = State.test.groups[i];
                    if (group.order && key && group.order.includes(key)) {
                        const wasPresent = !!group._mondaiById[key];
                        console.log(`[ProcessChunk] assigning ${key} to ${group.group_id}. Already present: ${wasPresent}`);
                        this.assignMondaiToGroup(group, m);
                        return;
                    }
                }
                // Fallback: push to last group
                if (State.test.groups.length > 0) {
                    const group = State.test.groups[State.test.groups.length - 1];
                    console.log(`[ProcessChunk] fallback assigning ${key || m.mondai_id} to last group ${group.group_id}`);
                    this.assignMondaiToGroup(group, m);
                }
            });
            this.updateProgressUI();
        },

        async loadRemainingChunksV2() {
            if (!State.currentInstanceKey) return;

            const instanceKey = State.currentInstanceKey;

            // Load all groups concurrently with bounded concurrency
            const loadGroup = async (gIdx) => {
                const group = State.test.groups[gIdx];
                const group_id = group.group_id;

                // Check if already full from initial chunk
                const manifestGroup = State.test.meta.manifest.groups.find(mg => mg.group_id === group_id);
                const expected = manifestGroup?.expected_mondai_count || 0;

                const currentCount = this.getLoadedMondaiCount(group);
                if (currentCount >= expected) {
                    console.log(`Group ${group_id} already has ${currentCount}/${expected} items.`);
                    return;
                }

                this.activeLoaders.add(group_id);
                let done = false;
                while (!done) {
                    try {
                        const res = await Api.fetchExamChunk(instanceKey, group_id, 3);

                        if (res.chunk && res.chunk.length > 0) {
                            res.chunk.forEach(m => {
                                const key = this.getMondaiKey(m);
                                const wasPresent = !!group._mondaiById[key];
                                this.assignMondaiToGroup(group, m);
                                console.log(`[ChunkReq] Recv ${key}. Present before: ${wasPresent}`);
                            });
                            this.updateNavigationButtons();
                            this.updateProgressUI();
                        }

                        done = res.done;
                        if (done) console.log(`Group ${group_id} fully loaded.`);
                        await new Promise(r => setTimeout(r, 300)); // Reduced delay for faster loading

                    } catch (e) {
                        console.error(`Error loading chunk for ${group_id}:`, e);
                        done = true; // Stop loop on error to avoid infinite retry
                    }
                }
                this.activeLoaders.delete(group_id);
                this.updateNavigationButtons();
            };

            // Schedule all groups concurrently with a small bounded window.
            RequestQueue.setLimit(4);
            const promises = State.test.groups.map((_, gIdx) =>
                RequestQueue.schedule(() => loadGroup(gIdx))
            );

            await Promise.all(promises);
            console.log('All chunks loaded (V2 concurrent).');
        },


        isGroupReady(groupIndex) {
            return State.test.groups[groupIndex] !== undefined;
        },

        simulateProgress(bar, text) {
            let progress = 0;
            const startTime = Date.now();
            const targetDuration = 25000; // 25 seconds to reach 98%

            return setInterval(() => {
                const elapsed = Date.now() - startTime;
                // Ease-out curve: fast at start, slow near end
                // Reaches 98% at ~25 seconds, then stops
                const targetProgress = 98 * (1 - Math.pow(1 - Math.min(elapsed / targetDuration, 1), 2));
                progress = Math.min(Math.round(targetProgress), 98);

                bar.style.width = `${progress}%`;
                text.textContent = `${progress}%`;
            }, 200);
        },

        collectUserHistory() {
            if (!State.userData) return null;

            const history = {};

            // Get last 5 tests
            if (State.userData.history && State.userData.history.length > 0) {
                history.recentResults = State.userData.history.slice(-5);
            }

            // Get mistake patterns
            if (State.userData.mistakeBook && State.userData.mistakeBook.length > 0) {
                // Count tags from mistakes
                const tagCounts = {};
                State.userData.mistakeBook.forEach(m => {
                    if (m.tags && Array.isArray(m.tags)) {
                        m.tags.forEach(tag => {
                            tagCounts[tag] = (tagCounts[tag] || 0) + 1;
                        });
                    }
                });

                // Get top 5 weak tags
                history.weakTags = Object.entries(tagCounts)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 5)
                    .map(([tag]) => tag);
            }

            return history;
        },



        initializeTest() {
            const test = State.test;

            // Start timers
            Timer.startOverallTimer(test.meta.time_limits.overall_sec);

            const firstGroup = test.meta.time_limits.groups[0];
            if (firstGroup) {
                $('#group-label').textContent = this.getGroupLabel(0);
                Timer.startGroupTimer(firstGroup.time_sec);
            }

            // Update total mondai count
            const totalMondai = this.getTotalMondaiCount();
            $('#mondai-total').textContent = totalMondai;

            // Render first mondai
            this.renderCurrentMondai();
        },

        getGroupLabel(groupIndex) {
            const group = State.test.groups[groupIndex];
            return group?.title_vi || 'Phần';
        },

        renderCurrentMondai() {
            // Stop runtime playing audio before rendering new mondai to PRESERVE cache 
            if (typeof TTSManager !== 'undefined' && TTSManager.stopRuntimeOnly) {
                try { TTSManager.stopRuntimeOnly(); } catch (_) { }
            }

            const test = State.test;
            const mondaiData = this.getCurrentMondaiData();

            if (!mondaiData) return;

            const { group, mondai } = mondaiData;
            const language = test.meta.language;
            const isJapanese = language === 'ja-JP';

            // Update navigation
            // globalIndex is based on State.test.groups (generated mondai)
            const globalIndex = this.getGlobalMondaiIndex();

            // Get current group from GENERATED test (for position within loaded mondai)
            const currentGroup = State.test.groups[State.currentGroupIndex];
            if (!currentGroup) return;

            // Total uses EXAM SPEC for the full intended count
            this.updateProgressUI();

            // Update navigation buttons (prev/next state based on loaded mondai)
            this.updateNavigationButtons();

            // Update header - prioritize meta.display_title, then title_vi, then fallback
            // Detect if listening type for proper prefix
            const isListening = mondai.items?.some(item =>
                item.type?.includes('listen') || item.type?.includes('dialogue') || item.type?.includes('mono')
            ) || !!mondai.media?.script_text;

            // Extract mondai number from mondai_id (M1->1, L2->2, etc.)
            const rawId = mondai.mondai_id || '';
            const mondaiNum = rawId.match(/[ML](\d+)/)?.[1] || String(State.currentMondaiIndex + 1);
            const prefix = isListening ? 'Listen' : 'Mondai';

            let displayTitle;
            if (mondai.meta?.display_title) {
                // Use generated display_title directly
                displayTitle = mondai.meta.display_title;
            } else if (mondai.title_vi && !mondai.title_vi.match(/^(Mondai|Listen)\s+\d+/)) {
                // Has title_vi but no prefix - add prefix
                displayTitle = `${prefix} ${mondaiNum}: ${mondai.title_vi}`;
            } else if (mondai.title_vi) {
                // title_vi already has proper format
                displayTitle = mondai.title_vi;
            } else {
                // Fallback to simple prefix + number
                displayTitle = `${prefix} ${mondaiNum}`;
            }

            $('#mondai-title').textContent = displayTitle;
            $('#mondai-instructions').textContent = mondai.instructions_vi || '';

            // Render passage if exists (with zoom controls)
            const passageContainer = $('#passage-container');
            const passageText = $('#passage-text');

            if (passageContainer) {
                if (mondai.passage?.text) {
                    passageContainer.classList.remove('hidden');
                    passageText.textContent = mondai.passage.text;
                    passageText.className = `passage-text ${isJapanese ? '' : 'zh'}`;
                } else {
                    passageContainer.classList.add('hidden');
                    passageText.textContent = '';
                }
            }

            // Render audio player for listening
            const audioPlayer = $('#audio-player');
            // Listening Mode B: audio script is at mondai.media.script_text
            const hasAudio = !!(mondai.media?.script_text ||
                mondai.items.some(item => item.media?.script_text)); // Legacy fallback
            const audioScript = $('#audio-script');
            const btnShowScript = $('#btn-show-script');

            if (hasAudio) {
                audioPlayer.classList.remove('hidden');

                // Setup script - prefer mondai.media.script_text (Mode B)
                let scriptText = mondai.media?.script_text;
                if (!scriptText) {
                    // Legacy fallback: check items (log warning for dev)
                    const legacyItem = mondai.items.find(item => item.media?.script_text);
                    if (legacyItem?.media?.script_text) {
                        scriptText = legacyItem.media.script_text;
                        console.warn('[DEV] Audio script found at item level, should be at mondai.media.script_text');
                    }
                }
                if (scriptText) {
                    btnShowScript.classList.remove('hidden');
                    audioScript.innerHTML = this.escapeHtml(scriptText).replace(/\n/g, '<br>');
                    audioScript.classList.add('hidden');
                    btnShowScript.textContent = 'Hiển thị lời thoại';
                } else {
                    btnShowScript.classList.add('hidden');
                    audioScript.innerHTML = '';
                }
            } else {
                audioPlayer.classList.add('hidden');
            }

            // Render questions
            this.renderQuestions(mondai.items, language);

            // Render question dots
            this.renderQuestionDots(mondai.items);

            // Update submit button text
            this.updateSubmitButtonLabel();
        },

        updateAudioButton(state) {
            const btn = $('#btn-play-audio');
            if (!btn) return;

            if (state === 'playing') {
                btn.innerHTML = `<span class="play-icon"><i class="fa-solid fa-pause"></i></span> Tạm dừng`;
            } else if (state === 'paused') {
                btn.innerHTML = `<span class="play-icon"><i class="fa-solid fa-play"></i></span> Tiếp tục`;
            } else if (state === 'loading') {
                btn.innerHTML = `<span class="play-icon"><i class="fa-solid fa-spinner fa-spin"></i></span> Đang tải...`;
            } else if (state === 'replay' || (State.ttsAudio && State.ttsAudio.ended)) {
                btn.innerHTML = `<span class="play-icon"><i class="fa-solid fa-rotate-left"></i></span> Nghe lại`;
            } else { // default (stopped/not started)
                btn.innerHTML = `<span class="play-icon"><i class="fa-solid fa-play"></i></span> Nghe`;
            }
        },

        async handleAudio() {
            const btn = $('#btn-play-audio');
            if (!btn) return;

            // Debounce to prevent double-clicks/double-events
            const now = Date.now();
            if (this._lastAudioClick && (now - this._lastAudioClick < 500)) {
                console.log('TPS: Audio click debounced');
                return;
            }
            this._lastAudioClick = now;

            console.log('TPS: handleAudio called', {
                isPlaying: TTSManager.isPlaying,
                isPaused: TTSManager.isPaused,
                hasCombinedBlob: !!TTSManager.combinedBlob,
                hasAudio: !!State.ttsAudio,
                audioPaused: State.ttsAudio?.paused,
                audioEnded: State.ttsAudio?.ended
            });

            // 1. If combined blob exists (replay mode or finished stream)
            if (TTSManager.combinedBlob && State.ttsAudio) {
                console.log('TPS: Using combined blob interaction');

                // If Ended -> Replay from start
                if (State.ttsAudio.ended) {
                    State.ttsAudio.currentTime = 0;
                    try {
                        await State.ttsAudio.play();
                        this.updateAudioButton('playing');
                    } catch (e) {
                        console.warn('Replay failed:', e);
                    }
                    return;
                }

                // If Paused -> Resume (Continue)
                if (State.ttsAudio.paused) {
                    try {
                        await State.ttsAudio.play();
                        this.updateAudioButton('playing');
                    } catch (e) {
                        console.warn('Resume failed:', e);
                    }
                    return;
                }

                // If Playing -> Pause
                if (!State.ttsAudio.paused) {
                    State.ttsAudio.pause();
                    this.updateAudioButton('paused');
                    return;
                }

                return;
            }

            // 2. Streaming Mode Interaction
            if (TTSManager.isPlaying) { // Currently streaming -> Pause
                console.log('TPS: Toggling pause (streaming)');
                const isNowPlaying = TTSManager.togglePause();
                this.updateAudioButton(isNowPlaying ? 'playing' : 'paused');
                return;
            }

            if (TTSManager.isPaused) { // Streaming paused -> Resume
                console.log('TPS: Resuming paused streaming');
                TTSManager.handleResumeStreaming(); // Helper to be safe
                this.updateAudioButton('playing');
                return;
            }

            // 3. Initial Start (No audio yet) - check cache first
            const mondaiData = this.getCurrentMondaiData();
            // Listening Mode B: prefer mondai.media.script_text
            let scriptText = mondaiData?.mondai?.media?.script_text;
            if (!scriptText) {
                // Legacy fallback
                const legacyItem = mondaiData?.mondai?.items?.find(item => item.media?.script_text);
                scriptText = legacyItem?.media?.script_text;
            }
            if (scriptText) {
                const lang = State.test.meta.language || getExamLanguage(State.test.meta.exam_id);

                // Quick SHA-256 for stable exact cache key
                const getSha256Str = async (str) => {
                    const msgBuffer = new TextEncoder().encode(str);
                    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
                    const hashArray = Array.from(new Uint8Array(hashBuffer));
                    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
                };

                const audioKey = await getSha256Str(`${lang}|${scriptText}`);

                // Set active key for this mondai
                TTSManager.setActiveKey(audioKey);

                // Check cache first - if hit, load and play from cache
                if (TTSManager.loadFromCacheIfAny(audioKey)) {
                    console.log('TTS: Playing from cache');
                    this.updateAudioButton('playing');
                    try {
                        await State.ttsAudio.play();
                    } catch (e) {
                        console.warn('Cache play failed:', e);
                    }
                    return;
                }

                // Cache miss - start new TTS stream
                console.log('TTS: Starting new TTS stream (cache miss)');
                this.updateAudioButton('loading');
                TTSManager.playAudio(scriptText, lang, audioKey);
            } else {
                showToast('Không có dữ liệu âm thanh cho bài này', 'info');
            }
        },






        toggleScript() {
            const script = $('#audio-script');
            const btn = $('#btn-show-script');
            if (script && btn) {
                script.classList.toggle('hidden');
                btn.textContent = script.classList.contains('hidden') ? 'Hiển thị lời thoại' : 'Ẩn lời thoại';
            }
        },

        getCurrentMondaiData() {
            let globalIdxCount = 0;
            for (const group of State.test.groups) {
                const count = this.getGroupMondaiCount(group);
                if (State.currentMondaiIndex >= globalIdxCount && State.currentMondaiIndex < globalIdxCount + count) {
                    const localIdx = State.currentMondaiIndex - globalIdxCount;
                    let mondai;
                    if (group.order && group.order.length > 0) {
                        const mId = group.order[localIdx];
                        mondai = group._mondaiById[mId];
                    } else {
                        mondai = group.mondai[localIdx];
                    }
                    if (mondai) return { group, mondai };
                }
                globalIdxCount += count;
            }
            return null;
        },

        // Check if a mondai at globalIndex has been loaded
        isMondaiLoaded(globalIndex) {
            if (globalIndex < 0) return false;
            let globalIdxCount = 0;
            for (const group of State.test.groups) {
                if (!group) continue;
                const count = this.getGroupMondaiCount(group);
                if (globalIndex >= globalIdxCount && globalIndex < globalIdxCount + count) {
                    const localIdx = globalIndex - globalIdxCount;
                    if (group.order && group.order.length > 0) {
                        const mId = group.order[localIdx];
                        return !!group._mondaiById[mId];
                    } else {
                        return !!group.mondai[localIdx];
                    }
                }
                globalIdxCount += count;
            }
            return false;
        },

        updateNavigationButtons() {
            if (!State.test || !State.examSpec) return;

            const globalIndex = this.getGlobalMondaiIndex();
            const totalMondaiFromSpec = this.getTotalMondaiCount();
            const nextMondaiLoaded = this.isMondaiLoaded(globalIndex + 1);

            // Update Previous button
            $('#btn-prev-mondai').disabled = globalIndex === 0;

            // Update Next button
            const btnNext = $('#btn-next-mondai');
            const isLast = globalIndex === totalMondaiFromSpec - 1;

            if (isLast) {
                btnNext.disabled = true;
                btnNext.innerHTML = '>';
                btnNext.onclick = null;
                if (this.nextLoadFailTimer) { clearTimeout(this.nextLoadFailTimer); this.nextLoadFailTimer = null; }
            } else if (!nextMondaiLoaded) {
                let remainingTarget = globalIndex + 1; // 0-indexed needs +1 
                let targetGroupId = null;
                if (State.test.meta?.manifest?.groups) {
                    for (const g of State.test.meta.manifest.groups) {
                        if (remainingTarget < g.expected_mondai_count) {
                            targetGroupId = g.group_id;
                            break;
                        }
                        remainingTarget -= g.expected_mondai_count;
                    }
                    if (!targetGroupId && State.test.meta.manifest.groups.length > 0) {
                        targetGroupId = State.test.meta.manifest.groups[State.test.meta.manifest.groups.length - 1].group_id;
                    }
                }

                if (this.showNextButtonRetryState) {
                    btnNext.disabled = false;
                    btnNext.innerHTML = '<span class="loading-spinner"><i class="fa-solid fa-rotate-right"></i></span> Lỗi tải tiếp';
                    btnNext.onclick = (e) => {
                        e.preventDefault();
                        if (targetGroupId) this.retryFetchNextMondai(targetGroupId);
                    };
                } else {
                    btnNext.disabled = true;
                    btnNext.innerHTML = '> <span class="loading-spinner"><i class="fa-solid fa-spinner fa-spin"></i> Đang tải tiếp...</span>';
                    btnNext.onclick = null;

                    if (targetGroupId && !this.activeLoaders.has(targetGroupId)) {
                        this.retryFetchNextMondai(targetGroupId);
                    }

                    if (!this.nextLoadFailTimer) {
                        this.nextLoadFailTimer = setTimeout(() => {
                            this.showNextButtonRetryState = true;
                            this.nextLoadFailTimer = null;
                            this.updateNavigationButtons();
                        }, 10000); // 10s timeout
                    }
                }
            } else {
                btnNext.disabled = false;
                btnNext.innerHTML = '>';
                btnNext.onclick = null;
                this.showNextButtonRetryState = false;
                if (this.nextLoadFailTimer) { clearTimeout(this.nextLoadFailTimer); this.nextLoadFailTimer = null; }
            }

            // Update loading indicator
            const loadingIndicator = $('#nav-loading-indicator');
            if (loadingIndicator) {
                if (!nextMondaiLoaded && globalIndex < totalMondaiFromSpec - 1) {
                    loadingIndicator.classList.remove('hidden');
                } else {
                    loadingIndicator.classList.add('hidden');
                }
            }

        },

        getGlobalMondaiIndex() {
            return State.currentMondaiIndex;
        },

        updateProgressUI() {
            if (!State.test || !State.examSpec) return;
            const currentGroupIdx = State.currentGroupIndex;
            const expected = this.getGroupExpectedCount(currentGroupIdx);
            const group = State.test.groups[currentGroupIdx];

            let loaded = 0;
            if (group) {
                loaded = this.getLoadedMondaiCount(group);
            }

            const progressCurrent = $('#mondai-current');
            const progressTotal = $('#mondai-total');

            if (progressCurrent && progressTotal) {
                progressCurrent.textContent = Math.min(loaded, expected);
                progressTotal.textContent = expected;
            }
        },

        updateSubmitButtonLabel() {
            const submitBtn = $('#btn-submit-group');
            if (!submitBtn) return;

            if (submitBtn.disabled && !submitBtn.textContent.includes('phần') && !submitBtn.textContent.includes('Nộp bài thi')) return;

            const isLastGroup = State.currentGroupIndex === State.examSpec.groups.length - 1;
            if (isLastGroup) {
                submitBtn.innerHTML = '<span class="btn-icon"><i class="fa-solid fa-flag-checkered"></i></span> Nộp bài thi';
                submitBtn.classList.remove('btn-secondary');
                submitBtn.classList.add('btn-primary');
            } else {
                const currentGroupTitle = this.getGroupLabel(State.currentGroupIndex);
                submitBtn.innerHTML = `Nộp phần ${currentGroupTitle}`;
                submitBtn.classList.remove('btn-primary');
                submitBtn.classList.add('btn-secondary');
            }
        },

        isLastMondaiInCurrentGroup() {
            if (!State.examSpec) return false;
            const currentGroupIdx = State.currentGroupIndex;
            const expected = this.getGroupExpectedCount(currentGroupIdx);
            const globalIndex = this.getGlobalMondaiIndex();

            let firstMondaiOfGroup = 0;
            for (let i = 0; i < currentGroupIdx; i++) {
                firstMondaiOfGroup += this.getGroupExpectedCount(i);
            }

            const mondaiPosInGroup = globalIndex - firstMondaiOfGroup;
            return mondaiPosInGroup === expected - 1;
        },

        getTotalMondaiCount() {
            // V2: Use manifest for total count (as mondai are loaded lazily)
            if (State.test.meta?.manifest) {
                return State.test.meta.manifest.groups.reduce((sum, g) => sum + (g.expected_mondai_count || 0), 0);
            }
            // V1 / Fallback
            return State.test.groups.reduce((sum, g) => sum + this.getGroupMondaiCount(g), 0);
        },

        renderQuestions(items, language) {
            const container = $('#questions-container');
            const isJapanese = language === 'ja-JP';

            container.innerHTML = items.map((item, idx) => {
                // Detect "Still generating" placeholder content which might come from LLM/Server during partial loads
                const isPlaceholder = item.choices && item.choices.some(c =>
                    c && (c.includes('tạo đề') ||
                        c.includes('Vui lòng đợi') ||
                        c.includes('Generating') ||
                        c.includes('đang tạo'))
                );

                if (isPlaceholder) {
                    return `
        <div class="question-item placeholder-item" data-question-id="${item.id}">
          <div class="question-number">Câu ${idx + 1}</div>
          <div class="question-prompt text-muted" style="text-align: center; padding: 2rem; color: #888;">
            <i class="fa-solid fa-spinner fa-spin"></i> Đang hoàn thiện nội dung câu hỏi...
          </div>
        </div>
      `;
                }

                return `
        <div class="question-item" data-question-id="${item.id}">
          <div class="question-number">Câu ${idx + 1}</div>
          <div class="question-prompt ${isJapanese ? '' : 'zh'}">${this.escapeHtml(item.prompt)}</div>
          <div class="choices">
            ${item.choices.map((choice, cIdx) => `
              <button class="choice ${isJapanese ? '' : 'zh'} ${State.answers[item.id] === cIdx ? 'selected' : ''}"
                      data-question-id="${item.id}"
                      data-choice-index="${cIdx}">
                <span class="choice-letter">${String.fromCharCode(65 + cIdx)}</span>
                <span class="choice-text">${this.escapeHtml(choice)}</span>
              </button>
            `).join('')}
          </div>
        </div>
      `;
            }).join('');

            // Add click handlers
            container.querySelectorAll('.choice').forEach(btn => {
                btn.addEventListener('click', () => this.selectChoice(btn));
            });
        },

        renderQuestionDots(items) {
            const container = $('#question-dots');

            container.innerHTML = items.map((item, idx) => `
        <div class="question-dot ${State.answers[item.id] !== undefined ? 'answered' : ''}"
             data-question-id="${item.id}"
             data-index="${idx}"></div>
      `).join('');

            container.querySelectorAll('.question-dot').forEach(dot => {
                dot.addEventListener('click', () => {
                    const questionId = dot.dataset.questionId;
                    const el = $(`[data-question-id="${questionId}"].question-item`);
                    if (el) {
                        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }
                });
            });
        },

        selectChoice(btn) {
            const questionId = btn.dataset.questionId;
            const choiceIndex = parseInt(btn.dataset.choiceIndex);

            State.answers[questionId] = choiceIndex;

            // Update UI
            const questionItem = btn.closest('.question-item');
            questionItem.querySelectorAll('.choice').forEach(c => c.classList.remove('selected'));
            btn.classList.add('selected');

            // Update dot
            const dot = $(`.question-dot[data-question-id="${questionId}"]`);
            if (dot) dot.classList.add('answered');
        },

        navigateMondai(direction) {
            const total = this.getTotalMondaiCount();
            const newIndex = State.currentMondaiIndex + direction;

            // Block forward navigation to unloaded mondai
            if (direction > 0 && !this.isMondaiLoaded(newIndex)) {
                return;
            }

            // Optional: Auto transition to next group if at boundary
            if (direction === 1 && this.isLastMondaiInCurrentGroup()) {
                const isLastGroup = State.currentGroupIndex === State.examSpec.groups.length - 1;
                if (!isLastGroup) {
                    const newGroupIndex = State.currentGroupIndex + 1;
                    const currentGrp = State.test.groups[State.currentGroupIndex];
                    const nextGrp = State.test.groups[newGroupIndex];
                    const expected = this.getGroupExpectedCount(newGroupIndex);
                    const loaded = nextGrp ? this.getLoadedMondaiCount(nextGrp) : 0;

                    console.log(`[Nav] Auto-transition group: ${currentGrp ? currentGrp.group_id : State.currentGroupIndex} -> ${nextGrp ? nextGrp.group_id : newGroupIndex} | Index: ${newGroupIndex} | Progress: ${loaded}/${expected}`);

                    let newGroupFirstIndex = 0;
                    for (let i = 0; i < newGroupIndex; i++) {
                        newGroupFirstIndex += this.getGroupExpectedCount(i);
                    }

                    TTSManager.stopRuntimeOnly();
                    TTSManager.resetPlayerUI();
                    this.updateAudioButton('idle');

                    State.currentGroupIndex = newGroupIndex;
                    State.currentMondaiIndex = newGroupFirstIndex;
                    State.currentQuestionIndex = 0;

                    const groupTime = State.test.meta.time_limits.groups[newGroupIndex];
                    if (groupTime) {
                        $('#group-label').textContent = this.getGroupLabel(newGroupIndex);
                        Timer.startGroupTimer(groupTime.time_sec);
                    }

                    this.renderCurrentMondai();
                    this.updateProgressUI();

                    const content = document.querySelector('.test-content');
                    if (content) content.scrollTo({ top: 0, behavior: 'smooth' });

                    // Pre-fetch next group's chunk unconditionally via deduplicator
                    const targetGroup = State.test.groups[newGroupIndex];
                    if (targetGroup && targetGroup.group_id && !this.activeLoaders.has(targetGroup.group_id)) {
                        this.retryFetchNextMondai(targetGroup.group_id);
                    }
                    return;
                }
            }

            // Stop current audio session before navigating (preserves cache)
            TTSManager.stopRuntimeOnly();
            TTSManager.resetPlayerUI();
            this.updateAudioButton('idle');

            if (newIndex >= 0 && newIndex < total) {
                // Check if crossing group boundary
                const oldGroupIndex = this.getGroupIndexForMondai(State.currentMondaiIndex);
                const newGroupIndex = this.getGroupIndexForMondai(newIndex);

                if (newGroupIndex !== oldGroupIndex) {
                    State.currentGroupIndex = newGroupIndex;
                    const groupTime = State.test.meta.time_limits.groups[newGroupIndex];
                    if (groupTime) {
                        $('#group-label').textContent = this.getGroupLabel(newGroupIndex);
                        Timer.startGroupTimer(groupTime.time_sec);
                    }
                }

                State.currentMondaiIndex = newIndex;
                this.renderCurrentMondai();

                // Scroll test content to top
                const content = document.querySelector('.test-content');
                if (content) {
                    content.scrollTo({ top: 0, behavior: 'smooth' });
                }
            }
        },

        getGroupIndexForMondai(mondaiIndex) {
            let idx = 0;
            for (let gi = 0; gi < State.test.groups.length; gi++) {
                const group = State.test.groups[gi];
                const count = this.getGroupMondaiCount(group);
                if (mondaiIndex < idx + count) {
                    return gi;
                }
                idx += count;
            }
            return 0;
        },

        getFirstMondaiIndexOfGroup(groupIndex) {
            let idx = 0;
            for (let gi = 0; gi < groupIndex; gi++) {
                idx += this.getGroupMondaiCount(State.test.groups[gi]);
            }
            return idx;
        },

        // Count unanswered questions in current scope
        countUnansweredInCurrentScope(scope = 'group') {
            let items = [];

            if (scope === 'group') {
                // Count in current group only
                const currentGroup = State.test.groups[State.currentGroupIndex];
                if (currentGroup) {
                    this.getOrderedMondaiList(currentGroup).forEach(m => {
                        if (m.items) items.push(...m.items);
                    });
                }
            } else {
                // Count all loaded items
                State.test.groups.forEach(g => {
                    if (g) {
                        this.getOrderedMondaiList(g).forEach(m => {
                            if (m.items) items.push(...m.items);
                        });
                    }
                });
            }

            return items.filter(item =>
                State.answers[item.id] === undefined ||
                State.answers[item.id] === null
            ).length;
        },

        // Show confirmation for unanswered questions
        async confirmUnansweredSubmit(count, isWholeTest = false) {
            const title = isWholeTest ? 'Nộp bài thi?' : 'Nộp phần này?';
            const msg = isWholeTest
                ? `Bạn còn ${count} câu chưa trả lời. Bạn vẫn muốn nộp bài thi?`
                : `Bạn còn ${count} câu chưa trả lời. Bạn vẫn muốn nộp phần này?`;
            return this.showConfirm(title, msg);
        },

        async moveToNextGroup() {
            // Prevent duplicate submissions
            if (this.isSubmitting) return;

            // Check for unanswered questions before proceeding
            const isLastGroup = State.currentGroupIndex === State.examSpec.groups.length - 1;
            const unansweredCount = this.countUnansweredInCurrentScope(isLastGroup ? 'all' : 'group');

            if (unansweredCount > 0) {
                const confirmed = await this.confirmUnansweredSubmit(unansweredCount, isLastGroup);
                if (!confirmed) return; // User cancelled, stay in test
            }

            const submitBtn = $('#btn-submit-group');
            const originalText = submitBtn.textContent;

            const currentGroupIdx = State.currentGroupIndex;
            const nextGroupIdx = currentGroupIdx + 1;
            const totalGroups = State.examSpec.groups.length;

            if (nextGroupIdx < totalGroups) {
                // Check if next group is ready
                if (!this.isGroupReady(nextGroupIdx)) {
                    // Disable button and show loading state
                    submitBtn.disabled = true;
                    submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang tải...';
                    showToast('Đang tải phần tiếp theo...', 'info');

                    // Wait for group to load (poll every 500ms)
                    while (!this.isGroupReady(nextGroupIdx) && this.loadingGroupIndex >= 0) {
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }

                    // Re-enable button after loading
                    submitBtn.disabled = false;
                    submitBtn.textContent = originalText;

                    // Check if group failed to load
                    if (this.pendingGroups[nextGroupIdx]?.error) {
                        showToast('Không thể tải phần tiếp theo: ' + this.pendingGroups[nextGroupIdx].error, 'error');
                        return;
                    }
                }

                State.currentGroupIndex = nextGroupIdx;

                // Find first mondai of next group
                let mondaiIdx = 0;
                for (let i = 0; i < nextGroupIdx; i++) {
                    mondaiIdx += this.getGroupMondaiCount(State.test.groups[i]);
                }
                State.currentMondaiIndex = mondaiIdx;

                // Start new group timer
                const groupTime = State.test.meta.time_limits.groups[nextGroupIdx];
                if (groupTime) {
                    $('#group-label').textContent = this.getGroupLabel(nextGroupIdx);
                    Timer.startGroupTimer(groupTime.time_sec);
                }

                this.renderCurrentMondai();
                window.scrollTo({ top: 0 });
            } else {
                // Last group - set submitting state and show grading options
                this.isSubmitting = true;
                submitBtn.disabled = true;
                submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang xử lý...';

                try {
                    await this.confirmSubmitTest();
                } finally {
                    // Re-enable on cancel or error (not on successful submit)
                    if (State.test) { // If still on test screen
                        this.isSubmitting = false;
                        submitBtn.disabled = false;
                        submitBtn.textContent = 'Nộp bài';
                    }
                }
            }
        },


        // Show grading options modal
        showGradingOptions() {
            return new Promise((resolve) => {
                const modal = $('#grading-modal');
                const btnQuick = $('#btn-grade-quick');
                const btnAI = $('#btn-grade-ai');
                const btnCancel = $('#btn-grade-cancel');

                modal.classList.remove('hidden');

                const cleanup = () => {
                    modal.classList.add('hidden');
                    btnQuick.onclick = null;
                    btnAI.onclick = null;
                    btnCancel.onclick = null;
                };

                btnQuick.onclick = () => {
                    cleanup();
                    resolve('quick');
                };

                btnAI.onclick = () => {
                    cleanup();
                    resolve('ai');
                };

                btnCancel.onclick = () => {
                    cleanup();
                    resolve(null);
                };
            });
        },

        // Show grading options instead of simple confirm
        async confirmSubmitTest() {
            const choice = await this.showGradingOptions();

            if (choice === 'quick') {
                await this.quickGradeTest();
            } else if (choice === 'ai') {
                await this.submitTest();
            }
            // null = cancelled, do nothing
        },

        // Quick grading without AI - instant results
        // Quick grading without AI - instant results
        async quickGradeTest() {
            Timer.stopAll();
            TTSManager.stop();

            // V2 Server-Side Grading
            if (State.currentInstanceKey) {
                try {
                    showScreen('loading-screen');
                    $('#loading-text').textContent = 'Đang chấm điểm';
                    $('#loading-hint').textContent = 'Đang kiểm tra kết quả từ hệ thống...';

                    const feedback = await Api.quickGradeV2(State.currentInstanceKey, State.answers);
                    feedback.grading_mode = 'quick';

                    // Transform by_question (Object) to Array for ReviewUI
                    // And merge with local content (which has prompts/choices but maybe not answers)
                    const questionsWithAnswers = [];
                    State.test.groups.forEach(group => {
                        TestUI.getOrderedMondaiList(group).forEach(mondai => {
                            mondai.items.forEach(item => {
                                const result = feedback.by_question[item.id];
                                if (result) {
                                    questionsWithAnswers.push({
                                        id: item.id,
                                        is_correct: result.is_correct,
                                        user_answer_index: State.answers[item.id],
                                        correct_index: result.correct_index,
                                        prompt: item.prompt,
                                        choices: item.choices,
                                        key_point_vi: item.explain_brief || '',
                                        tags: item.tags
                                    });
                                }
                            });
                        });
                    });
                    feedback.by_question = questionsWithAnswers;

                    State.feedback = feedback;
                    await this.saveToHistory(feedback);

                    ReviewUI.render();
                    showScreen('review-screen');
                    return;
                } catch (err) {
                    console.error('Quick Grade V2 Error:', err);
                    showToast('Lỗi chấm điểm: ' + err.message, 'error');
                    showScreen('test-screen');
                    return;
                }
            }

            // V1 Client-Side Grading (Legacy)
            const questionsWithAnswers = [];
            let correctCount = 0;
            let totalCount = 0;
            const scoreByGroup = {};

            // Determine if we can grade (check for answer_index)
            const firstMondai = TestUI.getOrderedMondaiList(State.test.groups[0])[0];
            const canGrade = firstMondai?.items?.[0]?.answer_index !== undefined;
            if (!canGrade) {
                showToast('Không thể chấm bài (thiếu đáp án). Vui lòng thử lại.', 'error');
                return;
            }

            State.test.groups.forEach(group => {
                let groupCorrect = 0;
                const mondaiList = this.getOrderedMondaiList(group);
                mondaiList.forEach(mondai => {
                    mondai.items.forEach(item => {
                        totalCount++;
                        const userAnswer = State.answers[item.id];
                        const isCorrect = userAnswer === item.answer_index;

                        if (isCorrect) {
                            correctCount++;
                            groupCorrect++;
                        }

                        questionsWithAnswers.push({
                            id: item.id,
                            is_correct: isCorrect,
                            user_answer_index: userAnswer !== undefined ? userAnswer : null,
                            correct_index: item.answer_index,
                            key_point_vi: item.explain_brief || '',
                            tags: item.tags
                        });
                    });
                });
                scoreByGroup[group.group_id] = groupCorrect;
            });

            const feedback = {
                score_summary: {
                    total_score: correctCount,
                    max_score: totalCount,
                    score_by_group: scoreByGroup,
                    weak_tags: [],
                    recommendation_vi: correctCount >= totalCount * 0.7
                        ? 'Kết quả tốt! Tiếp tục luyện tập để cải thiện.'
                        : 'Cần ôn tập thêm các phần còn yếu.'
                },
                by_question: questionsWithAnswers,
                grading_mode: 'quick'
            };

            State.feedback = feedback;
            await this.saveToHistory(feedback);

            ReviewUI.render();
            showScreen('review-screen');
        },

        // AI grading with detailed feedback
        async submitTest() {
            Timer.stopAll();
            TTSManager.stop();

            showScreen('loading-screen');
            $('#loading-text').textContent = 'Đang chấm điểm...';
            $('#loading-hint').textContent = 'AI đang phân tích và đánh giá câu trả lời của bạn...';

            // Get progress bar elements
            const progressBar = $('#loading-progress-inner');
            const progressText = $('#loading-progress-text');

            // Reset progress
            if (progressBar) progressBar.style.width = '0%';
            if (progressText) progressText.textContent = '0%';

            // Start simulated progress (same as question generation)
            const progressInterval = this.simulateProgress(progressBar, progressText);

            try {
                const llmProvider = $('#llm-provider').value;
                const feedback = await Api.gradeTest(
                    State.test, State.answers, llmProvider, null,
                    State.currentInstanceKey || null
                );
                feedback.grading_mode = 'ai';
                State.feedback = feedback;

                // Stop progress and complete to 100%
                clearInterval(progressInterval);
                if (progressBar) progressBar.style.width = '100%';
                if (progressText) progressText.textContent = '100%';
                await new Promise(resolve => setTimeout(resolve, 300));

                // Save to history
                await this.saveToHistory(feedback);

                ReviewUI.render();
                showScreen('review-screen');
            } catch (err) {
                clearInterval(progressInterval);
                console.error('Grade test error:', err);
                showToast('Không thể chấm điểm: ' + err.message, 'error');
                showScreen('home-screen');
            }
        },

        // Quit test without grading
        async quitTest() {
            const confirmed = await this.showConfirm(
                'Thoát bài thi?',
                'Bạn có muốn thoát? Bài thi sẽ KHÔNG được chấm điểm và tiến độ sẽ bị mất.'
            );
            if (confirmed) {
                Timer.stopAll();
                TTSManager.stop();

                // Reset all flags
                this.isStartingTest = false;
                this.isSubmitting = false;

                State.test = null;
                State.answers = {};
                State.currentMondaiIndex = 0;
                State.currentGroupIndex = 0;
                showScreen('home-screen');
                showToast('Đã thoát bài thi', 'info');
            }
        },

        // Generic confirmation dialog
        showConfirm(title, message) {
            return new Promise((resolve) => {
                const modal = $('#confirm-modal');
                const titleEl = $('#confirm-title');
                const messageEl = $('#confirm-message');
                const btnYes = $('#btn-confirm-yes');
                const btnNo = $('#btn-confirm-no');

                titleEl.textContent = title;
                messageEl.textContent = message;
                modal.classList.remove('hidden');

                const cleanup = () => {
                    modal.classList.add('hidden');
                    btnYes.onclick = null;
                    btnNo.onclick = null;
                };

                btnYes.onclick = () => {
                    cleanup();
                    resolve(true);
                };

                btnNo.onclick = () => {
                    cleanup();
                    resolve(false);
                };
            });
        },

        async saveToHistory(feedback) {
            if (!State.userData) State.userData = { history: [], mistakeBook: [] };
            if (!State.userData.history) State.userData.history = [];
            if (!State.userData.mistakeBook) State.userData.mistakeBook = [];

            // Add to history
            State.userData.history.push({
                date: new Date().toISOString(),
                exam: State.currentExam,
                mode: State.currentMode,
                score: feedback.score_summary?.total_score ?? feedback.summary?.score_total,
                maxScore: feedback.score_summary?.max_score ?? feedback.summary?.score_max,
                weakTags: feedback.score_summary?.weak_tags ?? feedback.summary?.weak_tags
            });

            // Add mistakes to mistake book (with optimized context)
            const incorrectItems = feedback.by_question.filter(q => !q.is_correct);
            for (const item of incorrectItems) {
                // Find the question and parent mondai in test
                let questionData = null;
                let parentMondai = null;

                for (const group of State.test.groups) {
                    for (const mondai of TestUI.getOrderedMondaiList(group)) {
                        const found = mondai.items.find(q => q.id === item.id);
                        if (found) {
                            questionData = found;
                            parentMondai = mondai;
                            break;
                        }
                    }
                    if (questionData) break;
                }

                if (questionData) {
                    // Build optimized question context (minimal storage)
                    const optimizedQuestion = {
                        id: questionData.id,
                        type: questionData.type,
                        prompt: questionData.prompt,
                        choices: questionData.choices,
                        answer_index: questionData.answer_index,
                        explain_brief: questionData.explain_brief,
                        tags: questionData.tags
                    };

                    // Add context text (passage or script) - truncated to save space
                    let contextText = null;
                    const MAX_CONTEXT_LENGTH = 500;

                    // Check for passage (reading questions)
                    if (parentMondai?.passage?.text) {
                        contextText = parentMondai.passage.text.length > MAX_CONTEXT_LENGTH
                            ? parentMondai.passage.text.substring(0, MAX_CONTEXT_LENGTH) + '...'
                            : parentMondai.passage.text;
                    }
                    // Check for audio script (listening questions)
                    else if (questionData.media?.script_text) {
                        contextText = questionData.media.script_text.length > MAX_CONTEXT_LENGTH
                            ? questionData.media.script_text.substring(0, MAX_CONTEXT_LENGTH) + '...'
                            : questionData.media.script_text;
                    }

                    if (contextText) {
                        optimizedQuestion.context = contextText;
                    }

                    State.userData.mistakeBook.push({
                        date: new Date().toISOString(),
                        exam: State.currentExam,
                        question: optimizedQuestion,
                        feedback: {
                            is_correct: item.is_correct,
                            why_wrong_vi: item.why_wrong_vi,
                            key_point_vi: item.key_point_vi,
                            mini_lesson_vi: item.mini_lesson_vi
                        },
                        userAnswer: State.answers[item.id]
                    });
                }
            }

            // Save to server
            try {
                await Api.saveUserData(State.userData);
            } catch (err) {
                console.warn('Failed to save user data:', err);
            }
        },

        togglePause() {
            State.isTestPaused = !State.isTestPaused;
            Timer.togglePause(State.isTestPaused);

            const btn = $('#btn-pause-test');
            btn.innerHTML = State.isTestPaused ? '<i class="fa-solid fa-play"></i>' : '<i class="fa-solid fa-pause"></i>';
            btn.title = State.isTestPaused ? 'Tiếp tục' : 'Tạm dừng';
        },

        toggleScript() {
            const script = $('#audio-script');
            const btn = $('#btn-show-script');

            if (script.classList.contains('hidden')) {
                script.classList.remove('hidden');
                btn.textContent = 'Ẩn lời thoại';
            } else {
                script.classList.add('hidden');
                btn.textContent = 'Hiển thị lời thoại';
            }
        },

        escapeHtml(text) {
            // Allow safe formatting tags for Japanese/Chinese text
            // Allowed: b, i, em, strong, ruby, rt, rp, br, span (NOT u - convert to .hl)
            const allowedTags = ['b', 'i', 'em', 'strong', 'ruby', 'rt', 'rp', 'br', 'span'];

            if (!text) return '';

            // First, temporarily replace allowed tags with placeholders
            let result = String(text);
            const placeholders = [];

            allowedTags.forEach(tag => {
                // Opening tags (with optional attributes for span)
                const openRegex = new RegExp(`<(${tag})(\\s[^>]*)?>`, 'gi');
                result = result.replace(openRegex, (match, tagName, attrs) => {
                    const idx = placeholders.length;
                    // For span, only allow class attribute
                    if (tagName.toLowerCase() === 'span' && attrs) {
                        const classMatch = attrs.match(/class="([^"]+)"/i);
                        placeholders.push(classMatch ? `<span class="${classMatch[1]}">` : '<span>');
                    } else {
                        placeholders.push(`<${tagName.toLowerCase()}>`);
                    }
                    return `\x00PH${idx}\x00`;
                });

                // Closing tags
                const closeRegex = new RegExp(`</${tag}>`, 'gi');
                result = result.replace(closeRegex, () => {
                    const idx = placeholders.length;
                    placeholders.push(`</${tag.toLowerCase()}>`);
                    return `\x00PH${idx}\x00`;
                });
            });

            // Convert [[...]] emphasis markers BEFORE escaping (preserve them)
            result = result.replace(/\[\[([^\]]+)\]\]/g, (match, content) => {
                const idx = placeholders.length;
                placeholders.push(`<strong class="hl">${content}</strong>`);
                return `\x00PH${idx}\x00`;
            });

            // Convert legacy <u>...</u> tags to .hl class (before escaping)
            result = result.replace(/<u>([^<]*)<\/u>/gi, (match, content) => {
                const idx = placeholders.length;
                placeholders.push(`<strong class="hl">${content}</strong>`);
                return `\x00PH${idx}\x00`;
            });

            // Now escape everything else
            const div = document.createElement('div');
            div.textContent = result;
            result = div.innerHTML;

            // Restore placeholders
            placeholders.forEach((ph, idx) => {
                result = result.replace(`\x00PH${idx}\x00`, ph);
            });

            return result;
        }
    };

    // ============================================
    // Review UI
    // ============================================
    const ReviewUI = {
        render() {
            const feedback = State.feedback;
            const test = State.test;

            // Score circle
            // Schema update: summary -> score_summary, score_total -> total_score, score_max -> max_score
            const scoreSummary = feedback.score_summary || feedback.summary || {};

            let scoreValue = scoreSummary.total_score !== undefined ? scoreSummary.total_score : (scoreSummary.score_total !== undefined ? scoreSummary.score_total : null);
            let scoreMax = scoreSummary.max_score !== undefined ? scoreSummary.max_score : (scoreSummary.score_max !== undefined ? scoreSummary.score_max : null);

            if (scoreValue === null || scoreMax === null) {
                const totalQuestions = feedback.by_question?.length || this.getTotalQuestions();
                const correctCount = feedback.by_question?.filter(q => q.is_correct).length || 0;

                if (scoreValue === null) scoreValue = correctCount;
                if (scoreMax === null) scoreMax = totalQuestions;
            }

            const percentage = scoreMax > 0 ? (scoreValue / scoreMax) * 100 : 0;

            $('#score-value').textContent = scoreValue;
            $('#score-max').textContent = `/${scoreMax}`;

            // Animate score ring
            const ring = $('#score-ring');
            const circumference = 2 * Math.PI * 45;
            ring.style.strokeDasharray = circumference;
            ring.style.strokeDashoffset = circumference - (percentage / 100) * circumference;

            // Add gradient def if not exists
            const svg = ring.closest('svg');
            if (!svg.querySelector('#scoreGradient')) {
                const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
                defs.innerHTML = `
          <linearGradient id="scoreGradient" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" style="stop-color:#6366f1"/>
            <stop offset="100%" style="stop-color:#8b5cf6"/>
          </linearGradient>
        `;
                svg.insertBefore(defs, svg.firstChild);
            }

            // Score by group
            const groupsHtml = Object.entries(scoreSummary.score_by_group || {})
                .map(([groupId, score]) => {
                    const group = test.groups.find(g => g.group_id === groupId);
                    const label = group?.title_vi || groupId;
                    return `
            <div class="score-group-item">
              <span class="score-group-label">${label}</span>
              <span>${score}</span>
            </div>
          `;
                }).join('');

            $('#score-by-group').innerHTML = groupsHtml;
            $('#recommendation').textContent = scoreSummary.recommendation_vi || '';

            // Weak tags & Improvement card
            const weakAreasCard = document.querySelector('.weak-areas');
            if (scoreSummary.weak_tags && scoreSummary.weak_tags.length > 0) {
                if (weakAreasCard) weakAreasCard.classList.remove('hidden');
                const tagsHtml = scoreSummary.weak_tags.map(tag => `<span class="tag">${tag}</span>`).join('');
                $('#weak-tags').innerHTML = tagsHtml;
            } else {
                if (weakAreasCard) weakAreasCard.classList.add('hidden');
                $('#weak-tags').innerHTML = '';
            }

            // Review list
            this.renderReviewList();
        },

        renderReviewList() {
            const feedback = State.feedback;
            const test = State.test;
            const isJapanese = test.meta.language === 'ja-JP';

            const html = feedback.by_question.map(item => {
                // Find question data
                let questionData = null;
                for (const group of test.groups) {
                    const mondaiList = TestUI.getOrderedMondaiList(group);
                    for (const mondai of mondaiList) {
                        const items = mondai.items || [];
                        const found = items.find(q => q.id === item.id);
                        if (found) {
                            questionData = found;
                            // Bubble up passage or script text for review rendering if not present on item
                            if (!questionData.passage && mondai.passage) questionData.passage = mondai.passage;
                            if (!questionData.media && mondai.media) questionData.media = mondai.media;
                            break;
                        }
                    }
                    if (questionData) break;
                }

                if (!questionData) return '';

                const userAnswer = State.answers[item.id];
                const correctAnswer = item.correct_index !== undefined ? item.correct_index : questionData.answer_index;

                // Bilingual extractors
                const whyWrongVi = item.why_wrong?.vi || item.why_wrong_vi;
                const whyWrongJa = item.why_wrong?.ja;
                const keyPointVi = item.key_point?.vi || item.key_point_vi;
                const keyPointJa = item.key_point?.ja;
                const miniLessonVi = item.mini_lesson?.vi || item.mini_lesson_vi;
                const miniLessonJa = item.mini_lesson?.ja;
                const hasExplanations = whyWrongVi || keyPointVi || miniLessonVi || questionData.media?.script_text;

                return `
          <div class="review-item ${item.is_correct ? '' : 'incorrect'}">
            <div class="review-item-header">
              <span class="review-item-id">${item.id}</span>
              <div style="display: flex; gap: 8px; align-items: center;">
                <span class="review-status ${item.is_correct ? 'correct' : 'incorrect'}">
                    ${item.is_correct ? '✓ Đúng' : '✗ Sai'}
                </span>
                <button onclick="ReviewUI.saveToNotebook('${item.id}')" class="btn btn-xs btn-outline" style="border: 1px solid var(--border); padding: 2px 8px; border-radius: 4px;" title="Lưu vào kho">
                    <i class="fa-solid fa-bookmark"></i>
                </button>
              </div>
            </div>
            <div class="review-prompt ${isJapanese ? '' : 'zh'}">${TestUI.escapeHtml(questionData.prompt)}</div>
            
            <div class="choices" style="margin-top: 12px;">
              ${questionData.choices.map((choice, idx) => {
                    let classes = 'choice review-choice ' + (isJapanese ? '' : 'zh');
                    if (idx === userAnswer) classes += ' user-selected';
                    if (idx === correctAnswer) classes += ' correct-answer';
                    if (idx === userAnswer && !item.is_correct) classes += ' wrong-answer';
                    return `
                  <div class="${classes}">
                    <span class="choice-letter">${String.fromCharCode(65 + idx)}</span>
                    <span class="choice-text">${TestUI.escapeHtml(choice)}</span>
                  </div>
                `;
                }).join('')}
            </div>
            
            ${!item.is_correct && correctAnswer !== undefined ? `
              <div class="correct-answer-label">
                ✓ Đáp án đúng: ${String.fromCharCode(65 + correctAnswer)}. ${TestUI.escapeHtml(questionData.choices[correctAnswer] || '')}
              </div>
            ` : ''}

            ${!item.is_correct && hasExplanations ? `
              <button class="explanation-toggle" onclick="this.classList.toggle('expanded'); this.nextElementSibling.classList.toggle('hidden');">
                <i class="fa-solid fa-chevron-right toggle-icon"></i> Xem giải thích
              </button>
              <div class="review-feedback hidden">
                ${whyWrongVi ? `
                  <div class="feedback-section">
                    <h4>Tại sao sai:</h4>
                    <p>${whyWrongVi}</p>
                    ${whyWrongJa ? `<div style="font-size: 0.9em; margin-top: 4px; color: var(--text-muted);">${whyWrongJa}</div>` : ''}
                  </div>` : ''}
                ${keyPointVi ? `
                  <div class="feedback-section">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                      <h4>Điểm ngữ pháp:</h4>
                      <button onclick="ReviewUI.saveGrammar('${item.id}')" class="btn btn-xs btn-outline" title="Lưu vào sổ tay"><i class="fa-solid fa-floppy-disk"></i> Lưu</button>
                    </div>
                    <p>${keyPointVi}</p>
                    ${keyPointJa ? `<div style="font-size: 0.9em; margin-top: 4px; color: var(--text-muted);">${keyPointJa}</div>` : ''}
                  </div>` : ''}
                ${miniLessonVi ? `
                  <div class="feedback-section">
                    <h4>Bài học nhỏ:</h4>
                    <p>${miniLessonVi}</p>
                    ${miniLessonJa ? `<div style="font-size: 0.9em; margin-top: 4px; color: var(--text-muted);">${miniLessonJa}</div>` : ''}
                  </div>` : ''}
                ${questionData.media?.script_text ? `<div class="feedback-section"><h4>Nội dung bài nghe:</h4><p class="script-text">${TestUI.escapeHtml(questionData.media.script_text).replace(/\n/g, '<br>')}</p></div>` : ''}
                ${(item.extra_examples?.length || item.extra_examples_target?.length) ? `
                  <div class="feedback-section">
                    <h4>Ví dụ thêm:</h4>
                    <ul class="examples-list ${isJapanese ? '' : 'zh'}">
                      ${item.extra_examples?.length ?
                                item.extra_examples.map(ex => `<li>${ex.ja || ex}<div style="font-size: 0.9em; margin-top: 2px; color: var(--text-muted);">${ex.vi || ''}</div></li>`).join('')
                                : item.extra_examples_target.map(ex => `<li>${ex}</li>`).join('')
                            }
                    </ul>
                  </div>
                ` : ''}
              </div>
            ` : ''}
          </div>
        `;
            }).join('');

            $('#review-list').innerHTML = html;
        },

        saveGrammar(questionId) {
            const feedback = State.feedback;
            // Find the item by question ID
            const item = feedback.by_question.find(q => q.id === questionId);
            if (!item) {
                showToast('Không tìm thấy dữ liệu câu hỏi', 'error');
                return;
            }

            const success = GrammarBook.save(
                item.key_point_vi,
                item.mini_lesson_vi || '',
                '', // Usage not always available from feedback
                item.extra_examples_target || []
            );

            if (success) {
                showToast('Đã lưu ngữ pháp!', 'success');
            } else {
                showToast('Ngữ pháp này đã có trong sổ tay.', 'error');
            }
        },

        async saveToNotebook(questionId) {
            // Find question data by searching through test groups
            let question = null;
            for (const group of State.test.groups) {
                for (const mondai of TestUI.getOrderedMondaiList(group)) {
                    const found = mondai.items.find(q => q.id === questionId);
                    if (found) {
                        question = found;
                        break;
                    }
                }
                if (question) break;
            }

            if (!question) {
                showToast('Không tìm thấy dữ liệu câu hỏi', 'error');
                return;
            }

            const note = prompt('Nhập ghi chú (tùy chọn):', '');
            if (note === null) return; // Cancelled

            try {
                // Determine tags based on question type
                const tags = [];
                if (question.type) tags.push(question.type);
                if (State.currentExam) tags.push(State.currentExam);

                const result = await Api.saveToNotebook(question, note, tags);
                if (result.success) {
                    showToast('Đã lưu vào kho kiến thức!', 'success');
                }
            } catch (err) {
                console.error('Save notebook error:', err);
                showToast('Lỗi lưu câu hỏi: ' + err.message, 'error');
            }
        },

        getTotalQuestions() {
            let count = 0;
            for (const group of State.test.groups) {
                for (const mondai of TestUI.getOrderedMondaiList(group)) {
                    count += mondai.items.length;
                }
            }
            return count;
        }
    };

    // Expose for onclick handlers
    window.ReviewUI = ReviewUI;

    // ============================================
    // History UI
    // ============================================
    const HistoryUI = {
        render() {
            const history = State.userData?.history || [];
            const container = $('#history-list');
            const emptyState = $('#history-empty');

            if (history.length === 0) {
                container.innerHTML = '';
                emptyState.classList.remove('hidden');
                return;
            }

            emptyState.classList.add('hidden');

            const html = history.slice().reverse().map((item, idx) => {
                const date = new Date(item.date).toLocaleDateString('vi-VN', {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                });
                const percentage = Math.round((item.score / item.maxScore) * 100);

                return `
          <div class="history-item">
            <div class="history-item-header">
              <span class="history-exam">${item.exam.toUpperCase()} - ${item.mode}</span>
              <span class="history-date">${date}</span>
            </div>
            <div class="history-score">${item.score}/${item.maxScore} (${percentage}%)</div>
          </div>
        `;
            }).join('');

            container.innerHTML = html;
        }
    };

    // ============================================
    // Mistakes UI
    // ============================================
    const MistakesUI = {
        render() {
            const mistakes = State.userData?.mistakeBook || [];
            const container = $('#mistakes-list');
            const emptyState = $('#mistakes-empty');

            if (mistakes.length === 0) {
                container.innerHTML = '';
                emptyState.classList.remove('hidden');
                return;
            }

            emptyState.classList.add('hidden');

            const html = mistakes.slice().reverse().slice(0, 50).map((item, idx) => {
                const realIdx = mistakes.length - 1 - idx;
                const date = new Date(item.date).toLocaleDateString('vi-VN');
                const question = item.question;
                const feedback = item.feedback;
                const userAnswer = item.userAnswer;
                const correctAnswer = question.answer_index;

                return `
          <div class="mistake-item" data-idx="${realIdx}">
            <div class="mistake-header" onclick="MistakesUI.toggle(${realIdx})">
              <span class="mistake-meta">${item.exam.toUpperCase()} - ${date}</span>
              <i class="fa-solid fa-chevron-down expand-icon"></i>
            </div>
            <div class="mistake-prompt">${TestUI.escapeHtml(question.prompt)}</div>
            
            <div class="mistake-detail hidden">
              <div class="choices" style="margin-top: 12px;">
                ${question.choices.map((choice, cIdx) => {
                    let classes = 'choice review-choice';
                    if (cIdx === userAnswer) classes += ' user-selected';
                    if (cIdx === correctAnswer) classes += ' correct-answer';
                    if (cIdx === userAnswer && cIdx !== correctAnswer) classes += ' wrong-answer';
                    return `
                    <div class="${classes}">
                      <span class="choice-letter">${String.fromCharCode(65 + cIdx)}</span>
                      <span class="choice-text">${TestUI.escapeHtml(choice)}</span>
                    </div>
                  `;
                }).join('')}
              </div>
              
              <div class="mistake-feedback">
                ${feedback.why_wrong_vi ? `<div class="feedback-section"><h4>Tại sao sai:</h4><p>${feedback.why_wrong_vi}</p></div>` : ''}
                ${feedback.key_point_vi ? `<div class="feedback-section"><h4>Điểm ngữ pháp:</h4><p>${feedback.key_point_vi}</p></div>` : ''}
                ${feedback.mini_lesson_vi ? `<div class="feedback-section"><h4>Bài học nhỏ:</h4><p>${feedback.mini_lesson_vi}</p></div>` : ''}
              </div>
            </div>
          </div>
        `;
            }).join('');

            container.innerHTML = html;
        },

        toggle(idx) {
            const container = $('#mistakes-list');
            const item = container.querySelector(`[data-idx="${idx}"]`);
            const detail = item?.querySelector('.mistake-detail');
            const icon = item?.querySelector('.expand-icon');

            if (!detail) return;

            const isExpanded = !detail.classList.contains('hidden');

            // Close all others
            container.querySelectorAll('.mistake-detail').forEach(d => d.classList.add('hidden'));
            container.querySelectorAll('.expand-icon').forEach(i => i.style.transform = 'rotate(0deg)');

            if (!isExpanded) {
                detail.classList.remove('hidden');
                if (icon) icon.style.transform = 'rotate(180deg)';
            }
        }
    };

    // Expose for onclick handlers
    window.MistakesUI = MistakesUI;

    // ============================================
    // Grammar Book Module
    // ============================================
    const GrammarBook = {
        save(point, meaning, usage, examples) {
            if (!State.userData) return false;

            const book = State.userData.grammarBook || [];

            // Check for duplicates
            const exists = book.some(item => item.point === point);
            if (exists) return false;

            book.push({
                point,
                meaning,
                usage,
                examples,
                date: new Date().toISOString()
            });

            State.userData.grammarBook = book;
            Api.saveUserData(State.userData);
            return true;
        },

        getAll() {
            return State.userData?.grammarBook || [];
        },

        remove(index) {
            if (!State.userData?.grammarBook) return;
            State.userData.grammarBook.splice(index, 1);
            Api.saveUserData(State.userData);
        }
    };

    // ============================================
    // Grammar UI
    // ============================================
    const GrammarUI = {
        render() {
            const list = GrammarBook.getAll();
            const container = $('#grammar-list');

            if (list.length === 0) {
                container.innerHTML = '<div class="empty-state">Chưa có ngữ pháp nào được lưu.</div>';
                return;
            }

            container.innerHTML = list.slice().reverse().map((item, idx) => `
                <div class="grammar-item" onclick="GrammarUI.showDetail(${list.length - 1 - idx})">
                    <h3>${TestUI.escapeHtml(item.point)}</h3>
                    <div class="grammar-meaning">${TestUI.escapeHtml(item.meaning)}</div>
                </div>
            `).join('');

            // Expose globally for onclick
            window.GrammarUI = this;
        },

        showDetail(index) {
            const list = GrammarBook.getAll();
            const item = list[index];
            if (!item) return;

            $('#grammar-title').textContent = item.point;
            $('#grammar-meaning').innerHTML = `<strong>Ý nghĩa</strong><p>${TestUI.escapeHtml(item.meaning)}</p>`;
            $('#grammar-usage').innerHTML = item.usage ? `<strong>Cách dùng</strong><p>${TestUI.escapeHtml(item.usage)}</p>` : '';

            if (item.examples && item.examples.length > 0) {
                const examplesHtml = item.examples.map(ex => `<li>${TestUI.escapeHtml(ex)}</li>`).join('');
                $('#grammar-examples').innerHTML = `<strong>Ví dụ</strong><ul>${examplesHtml}</ul>`;
            } else {
                $('#grammar-examples').innerHTML = '';
            }

            // Mazii link
            const query = encodeURIComponent(item.point);
            $('#grammar-link').href = `https://mazii.net/vi-VN/search/word?dict=javi&query=${query}&hl=vi-VN`;

            $('#grammar-detail').classList.remove('hidden');

            // On mobile, hide list
            if (window.innerWidth <= 768) {
                $('#grammar-list').classList.add('hidden');
            }
        },

        closeDetail() {
            $('#grammar-detail').classList.add('hidden');
            $('#grammar-list').classList.remove('hidden');
        }
    };

    // ============================================
    // Theme Module
    // ============================================
    const Theme = {
        currentTheme: 'dark',

        init() {
            // Load from localStorage or use system preference
            const saved = localStorage.getItem('theme');
            if (saved) {
                this.currentTheme = saved;
            } else {
                // Check system preference
                const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
                this.currentTheme = prefersDark ? 'dark' : 'light';
            }
            this.apply();
        },

        toggle() {
            this.currentTheme = this.currentTheme === 'dark' ? 'light' : 'dark';
            this.apply();
            localStorage.setItem('theme', this.currentTheme);
        },

        apply() {
            const html = document.documentElement;
            if (this.currentTheme === 'light') {
                html.setAttribute('data-theme', 'light');
            } else {
                html.removeAttribute('data-theme');
            }
            this.updateToggleButton();
        },

        updateToggleButton() {
            const btn = $('#btn-theme-toggle');
            if (btn) {
                btn.innerHTML = this.currentTheme === 'dark' ? '<i class="fa-solid fa-sun"></i>' : '<i class="fa-solid fa-moon"></i>';
                btn.title = this.currentTheme === 'dark' ? 'Chuyển sang chế độ sáng' : 'Chuyển sang chế độ tối';
            }
        }
    };

    const AdminUI = {
        storageKey: 'admin_warmup_secret',
        config: null,

        init() {
            const secretInput = $('#admin-secret');
            if (!secretInput) return;

            const savedSecret = sessionStorage.getItem(this.storageKey) || '';
            secretInput.value = savedSecret;

            secretInput.addEventListener('input', (event) => {
                sessionStorage.setItem(this.storageKey, event.target.value.trim());
            });

            $('#btn-admin-load')?.addEventListener('click', () => this.loadConfig());
            $('#btn-admin-healthcheck')?.addEventListener('click', () => this.runHealthcheck());
        },

        getSecret() {
            return ($('#admin-secret')?.value || '').trim();
        },

        setBadge(tone, text) {
            const badge = $('#admin-health-badge');
            if (!badge) return;
            badge.className = `status-badge ${tone}`;
            badge.textContent = text;
        },

        setSummary(lines) {
            const summary = $('#admin-config-summary');
            if (!summary) return;
            summary.innerHTML = lines.map((line) => `<p>${line}</p>`).join('');
        },

        renderEnvBlock(config) {
            const output = $('#admin-env-output');
            if (!output) return;

            const env = config?.env || {};
            output.textContent = [
                `OPENROUTER_MODEL_GENERATE_PRIMARY=${env.OPENROUTER_MODEL_GENERATE_PRIMARY || ''}`,
                `OPENROUTER_MODEL_GENERATE_SECONDARY=${env.OPENROUTER_MODEL_GENERATE_SECONDARY || ''}`,
                `OPENROUTER_MODEL_REPAIR_PRIMARY=${env.OPENROUTER_MODEL_REPAIR_PRIMARY || ''}`,
                `OPENROUTER_MODEL_REPAIR_SECONDARY=${env.OPENROUTER_MODEL_REPAIR_SECONDARY || ''}`,
                `OPENROUTER_MODEL_EXPLAIN_PRIMARY=${env.OPENROUTER_MODEL_EXPLAIN_PRIMARY || ''}`,
                `OPENROUTER_MODEL_EXPLAIN_SECONDARY=${env.OPENROUTER_MODEL_EXPLAIN_SECONDARY || ''}`,
                `OPENROUTER_RPM=${env.OPENROUTER_RPM || ''}`,
                `BLUEPRINT_GENERATION_CONCURRENCY=${env.BLUEPRINT_GENERATION_CONCURRENCY || ''}`,
                `BLUEPRINT_GENERATION_CONCURRENCY_EFFECTIVE=${env.BLUEPRINT_GENERATION_CONCURRENCY_EFFECTIVE || ''}`,
                `GEMINI_MODEL_FALLBACK=${env.GEMINI_MODEL_FALLBACK || ''}`,
                `GEMINI_MODEL_FALLBACK_COMPAT=${env.GEMINI_MODEL_FALLBACK_COMPAT || ''}`,
                `GEMINI_EMBEDDING_MODEL_PRIMARY=${env.GEMINI_EMBEDDING_MODEL_PRIMARY || ''}`,
                `GEMINI_EMBEDDING_MODEL_SECONDARY=${env.GEMINI_EMBEDDING_MODEL_SECONDARY || ''}`,
                `EMBEDDING_BACKFILL_BATCH_SIZE=${env.EMBEDDING_BACKFILL_BATCH_SIZE || ''}`,
                `EMBEDDING_BATCH_MAX_ITEMS=${env.EMBEDDING_BATCH_MAX_ITEMS || ''}`,
                `EMBEDDING_BATCH_MAX_CHARS=${env.EMBEDDING_BATCH_MAX_CHARS || ''}`
            ].join('\n');
        },

        renderHealthResults(results = []) {
            const container = $('#admin-health-results');
            if (!container) return;

            if (!results.length) {
                container.innerHTML = '';
                return;
            }

            container.innerHTML = results.map((item) => `
                <article class="admin-health-item">
                    <header>
                        <strong>${item.task} · ${item.provider}</strong>
                        <span class="status-badge ${item.ok ? 'success' : 'error'}">${item.ok ? 'Pass' : 'Fail'}</span>
                    </header>
                    <p class="admin-health-meta">${item.name} · ${item.model}</p>
                    <p class="admin-health-meta">Latency: ${item.latencyMs}ms${item.status ? ` · HTTP ${item.status}` : ''}${item.retryable ? ' · retryable' : ''}</p>
                    ${item.error ? `<p class="admin-health-error">${item.error}</p>` : ''}
                </article>
            `).join('');
        },

        async loadConfig() {
            const secret = this.getSecret();
            if (!secret) {
                showToast('Nhập WARMUP_SECRET để tải cấu hình admin.', 'warning');
                return;
            }

            this.setBadge('neutral', 'Đang tải');

            try {
                const response = await Api.getAdminLlmConfig(secret);
                this.config = response.config;
                const config = response.config;
                const taskSummary = Object.entries(config.tasks || {})
                    .map(([task, stages]) => `${task}: ${Array.isArray(stages) ? stages.length : 0} stage`)
                    .join(' · ');

                this.setSummary([
                    `OpenRouter: ${config.openrouterConfigured ? 'configured' : 'missing'} · Gemini: ${config.geminiConfigured ? 'configured' : 'missing'} · Embeddings: ${config.embeddingConfigured ? 'configured' : 'missing'}`,
                    `Router stages: ${taskSummary}`,
                    'Muốn đổi model cho toàn project: sửa env trên local hoặc Vercel rồi redeploy.'
                ]);
                this.renderEnvBlock(config);
                this.setBadge('success', 'Đã tải');
                showToast('Đã tải cấu hình AI hiện tại.', 'success');
            } catch (error) {
                this.setBadge('error', 'Lỗi auth');
                this.setSummary([
                    'Không tải được cấu hình admin.',
                    error.message
                ]);
                showToast(`Lỗi admin: ${error.message}`, 'error');
            }
        },

        async runHealthcheck() {
            const secret = this.getSecret();
            if (!secret) {
                showToast('Nhập WARMUP_SECRET để probe models.', 'warning');
                return;
            }

            this.setBadge('neutral', 'Đang probe');
            this.renderHealthResults([]);

            try {
                const response = await Api.runAdminLlmHealthcheck(secret);
                const summary = response.summary || {};
                this.renderHealthResults(response.results || []);

                const tone = summary.failed > 0 ? (summary.passed > 0 ? 'warning' : 'error') : 'success';
                this.setBadge(tone, `${summary.passed || 0}/${summary.total || 0} pass`);
                showToast(`Probe xong: ${summary.passed || 0} pass / ${summary.failed || 0} fail`, summary.failed > 0 ? 'warning' : 'success');
            } catch (error) {
                this.setBadge('error', 'Probe lỗi');
                showToast(`Không probe được models: ${error.message}`, 'error');
            }
        }
    };

    // ============================================
    // Event Handlers
    // ============================================
    function initEventHandlers() {
        // Auth
        $('#btn-email-login').addEventListener('click', () => Auth.loginWithEmail());

        $('#btn-demo-login').addEventListener('click', async (e) => {
            const btn = e.target.closest('button');
            if (btn.disabled) return;

            btn.disabled = true;
            const originalText = btn.innerHTML;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang vào...';

            try {
                await Auth.loginDemo();
                // Success will change screen, no need to revert
            } catch (err) {
                console.error(err);
                btn.disabled = false;
                btn.innerHTML = originalText;
                showToast('Lỗi đăng nhập demo', 'error');
            }
        });

        $('#btn-logout').addEventListener('click', () => Auth.logout());

        // Theme toggle
        $('#btn-theme-toggle')?.addEventListener('click', () => Theme.toggle());

        // Exam selection (using wrapper classes)
        $$('.exam-tab-wrapper').forEach(wrapper => {
            wrapper.addEventListener('click', (e) => {
                // Don't select if clicking on the dropdown itself or if disabled
                if (e.target.tagName === 'SELECT' || wrapper.getAttribute('aria-disabled') === 'true') return;

                $$('.exam-tab-wrapper').forEach(w => w.classList.remove('active'));
                wrapper.classList.add('active');
                State.currentExam = wrapper.dataset.exam;

                // Show section selector when exam is selected
                const sectionSelector = $('#exam-section-selector');
                if (sectionSelector) {
                    sectionSelector.classList.remove('hidden');
                }
            });
        });

        // Section selection
        $$('.section-option').forEach(option => {
            option.addEventListener('click', () => {
                $$('.section-option').forEach(o => o.classList.remove('selected'));
                option.classList.add('selected');
                State.currentSection = option.dataset.section;
            });
        });

        // Mode selection
        $$('.mode-card').forEach(card => {
            card.addEventListener('click', () => {
                $$('.mode-card').forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');
                State.currentMode = card.dataset.mode;
            });
        });

        // Settings toggle
        $('.settings-toggle').addEventListener('click', () => {
            $('.provider-settings').classList.toggle('collapsed');
        });

        // Start test
        $('#btn-start-test').addEventListener('click', () => TestUI.startTest());

        // Grammar Book
        $('#btn-grammar')?.addEventListener('click', () => {
            GrammarUI.render();
            showScreen('grammar-screen');
        });
        $('#btn-back-grammar')?.addEventListener('click', () => showScreen('home-screen'));
        $('#btn-close-grammar-detail')?.addEventListener('click', () => GrammarUI.closeDetail());

        // Test navigation
        $('#btn-prev-mondai').addEventListener('click', () => TestUI.navigateMondai(-1));
        $('#btn-next-mondai').addEventListener('click', () => TestUI.navigateMondai(1));
        $('#btn-pause-test').addEventListener('click', () => TestUI.togglePause());
        $('#btn-submit-group').addEventListener('click', () => TestUI.moveToNextGroup());
        $('#btn-quit-test')?.addEventListener('click', () => TestUI.quitTest());

        // Passage controls
        $('#btn-zoom-in').addEventListener('click', () => {
            const passage = $('#passage-text');
            const currentSize = parseFloat(getComputedStyle(passage).fontSize);
            passage.style.fontSize = `${currentSize + 2}px`;
        });

        $('#btn-zoom-out').addEventListener('click', () => {
            const passage = $('#passage-text');
            const currentSize = parseFloat(getComputedStyle(passage).fontSize);
            if (currentSize > 12) {
                passage.style.fontSize = `${currentSize - 2}px`;
            }
        });

        $('#btn-focus-mode').addEventListener('click', () => {
            const passage = $('#passage-text').textContent;
            $('#focus-passage').textContent = passage;
            $('#focus-overlay').classList.remove('hidden');
        });

        $('#btn-close-focus').addEventListener('click', () => {
            $('#focus-overlay').classList.add('hidden');
        });

        // Audio controls
        $('#btn-play-audio')?.addEventListener('click', () => TestUI.handleAudio());
        $('#btn-replay-audio')?.addEventListener('click', () => {
            if (State.ttsAudio && State.ttsAudio.duration) {
                State.ttsAudio.currentTime = Math.max(0, State.ttsAudio.currentTime - 5);
            }
        });
        $('#btn-show-script')?.addEventListener('click', () => TestUI.toggleScript());

        // Audio seek bar
        $('#audio-seek')?.addEventListener('input', (e) => {
            if (State.ttsAudio && State.ttsAudio.duration) {
                State.ttsAudio.currentTime = (e.target.value / 100) * State.ttsAudio.duration;
            }
        });

        // Review back
        $('#btn-back-home').addEventListener('click', () => {
            State.test = null;
            State.feedback = null;
            State.answers = {};
            showScreen('home-screen');
        });

        // History
        $('#btn-history').addEventListener('click', () => {
            HistoryUI.render();
            showScreen('history-screen');
        });
        $('#btn-history-back').addEventListener('click', () => showScreen('home-screen'));

        // Mistakes
        $('#btn-mistakes').addEventListener('click', () => {
            MistakesUI.render();
            showScreen('mistakes-screen');
        });
        $('#btn-mistakes-back').addEventListener('click', () => showScreen('home-screen'));

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if ($('#test-screen').classList.contains('active')) {
                if (e.key === 'ArrowLeft') {
                    TestUI.navigateMondai(-1);
                } else if (e.key === 'ArrowRight') {
                    TestUI.navigateMondai(1);
                }
            }
        });
    }

    // ============================================
    // Initialization
    // ============================================
    async function init() {
        console.log('Language Exam Practice App initializing...');

        Theme.init();
        AdminUI.init();
        initEventHandlers();
        await Auth.init();

        // Only show login screen if no session was restored
        if (!State.user) {
            showScreen('login-screen');
        }

        console.log('App initialized');
    }

    // Start the app
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
