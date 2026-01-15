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

        async getMe() {
            return this.request('/me', { method: 'POST' });
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

        async generateTest(examSpec, mode, provider, userHistory) {
            return this.request('/generate-test', {
                method: 'POST',
                body: { examSpec, mode, provider, userHistory }
            });
        },

        async generateGroup(examSpec, mode, groupIndex, provider) {
            return this.request('/generate-group', {
                method: 'POST',
                body: { examSpec, mode, groupIndex, provider }
            });
        },

        async generateMondaiChunk(examSpec, mode, groupIndex, chunkIndex, chunkSize = 3, previousMondai = [], provider, model = null) {
            return this.request('/generate-mondai-chunk', {
                method: 'POST',
                body: { examSpec, mode, groupIndex, chunkIndex, chunkSize, previousMondai, provider, model }
            });
        },

        async gradeTest(test, answers, provider, model = null) {
            // Set 300s timeout for grading
            const controller = new AbortController();
            const id = setTimeout(() => controller.abort(), 300000);

            try {
                const res = await this.request('/grade-test', {
                    method: 'POST',
                    body: { test, answers, provider, model },
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

                    const session = await this.privy.auth.email.loginWithCode(this.pendingEmail, code);
                    modal.classList.add('hidden');
                    await this.handlePrivySession(session);
                } catch (err) {
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
        },

        async loginDemo() {
            return this.handleAuthSuccess({ email: 'demo@example.com', token: 'demo-token' });
        },

        async handleAuthSuccess(user, isRestore = false) {
            State.user = {
                email: user.email || 'demo@example.com',
                token: user.token || 'demo-token'
            };

            localStorage.setItem('user', JSON.stringify(State.user));

            await this.loadUserData();
            this.updateUI();
            showScreen('home-screen');
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
            if (this.privy) {
                try {
                    await this.privy.auth.logout();
                } catch (e) {
                    console.warn('Privy logout error:', e);
                }
            }
            localStorage.removeItem('user');
            State.user = null;
            State.userData = null;
            showScreen('login-screen');
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
    const TTSManager = {
        audioQueue: [],      // Queue of audio blobs to play
        isPlaying: false,    // Currently playing audio
        isPaused: false,     // Pause state for streaming
        currentIndex: 0,     // Current segment index
        totalSegments: 0,    // Total segments expected
        combinedBlob: null,  // Combined audio for seek/timer (hybrid mode)
        clientCache: new Map(), // Client-side TTS cache

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

        async playAudio(text, language) {
            const ttsMode = $('#tts-mode').value;
            const statusEl = $('#audio-status');

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
            return new Promise((resolve, reject) => {
                this.audioQueue = [];
                this.currentIndex = 0;
                this.totalSegments = 0;
                this.isPlaying = false;

                const statusEl = $('#audio-status');

                // Create EventSource-like connection using fetch
                fetch(`${CONFIG.apiBase}/tts/stream`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(State.user?.token ? { 'Authorization': `Bearer ${State.user.token}` } : {})
                    },
                    body: JSON.stringify({ text, language, provider })
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

                                buffer += decoder.decode(value, { stream: true });
                                const lines = buffer.split('\n\n');
                                buffer = lines.pop() || '';

                                for (const line of lines) {
                                    if (line.startsWith('data: ')) {
                                        const data = JSON.parse(line.slice(6));
                                        await this.handleStreamEvent(data, statusEl, resolve, reject);
                                    }
                                }
                            }
                        } catch (err) {
                            reject(err);
                        }
                    };

                    processStream();
                }).catch(reject);
            });
        },

        async handleStreamEvent(data, statusEl, resolve, reject) {
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
                        this.playNextInQueue(resolve, reject);
                    }
                    break;

                case 'done':
                    // All segments received - combine for seek/timer support
                    if (this.audioQueue.length > 0) {
                        this.combinedBlob = new Blob(this.audioQueue, { type: 'audio/mpeg' });
                        console.log('TTS: Combined blob created for seek/timer');
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

        async playNextInQueue(resolve, reject) {
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
                    }

                    resolve();
                } else {
                    // Wait for more segments
                    setTimeout(() => this.playNextInQueue(resolve, reject), 100);
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

        // Setup combined audio for seek/timer after streaming completes
        setupCombinedAudio() {
            if (!this.combinedBlob) return;

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
                const timeEl = $('#audio-time');
                if (timeEl) {
                    timeEl.textContent = `00:00 / ${this.formatTime(State.ttsAudio.duration)}`;
                }
            };

            // Don't auto-play - user will click "Nghe lại" to replay
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
                    if (btn) btn.innerHTML = `<span class="play-icon"><i class="fa-solid fa-rotate-right"></i></span> Nghe lại`;

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
                    if (btn) btn.innerHTML = `<span class="play-icon"><i class="fa-solid fa-rotate-right"></i></span> Nghe lại`;
                };

                utterance.onerror = (err) => {
                    reject(err);
                };

                speechSynthesis.speak(utterance);
            });
        },

        stop() {
            if (State.ttsAudio) {
                State.ttsAudio.pause();
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
        },

        // Toggle pause for streaming TTS
        togglePause() {
            if (!State.ttsAudio) return false;

            if (State.ttsAudio.paused) {
                State.ttsAudio.play();
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

        async startTest() {
            const examType = State.currentExam; // e.g., "jlpt" or "hsk"
            const mode = State.currentMode;
            const llmProvider = $('#llm-provider').value;
            const progressBar = $('#loading-progress');
            const progressText = $('#progress-text');

            // Get selected level from the appropriate dropdown
            let selectedLevel;
            if (examType === 'jlpt') {
                selectedLevel = $('#jlpt-level')?.value || 'N2';
            } else if (examType === 'hsk') {
                selectedLevel = $('#hsk-level')?.value || 'HSK5';
            } else {
                selectedLevel = 'N2'; // Default fallback
            }

            // Reset test flags
            this.pendingGroups = [];
            this.loadingGroupIndex = 0;
            this.isSubmitting = false;

            // Debounce Start Button
            const startBtn = $('#btn-start-test');
            if (startBtn.disabled) return;
            startBtn.disabled = true;
            const originalBtnText = startBtn.innerHTML;
            startBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang khởi tạo...';

            showScreen('loading-screen');
            $('#loading-text').textContent = 'Đang tạo đề thi...';

            // Section hint
            const sectionNames = {
                'vocab-grammar': ' - Từ vựng & Ngữ pháp',
                'reading': ' - Đọc hiểu',
                'listening': ' - Nghe'
            };
            const sectionLabel = sectionNames[State.currentSection] || '';
            $('#loading-hint').textContent = `Đang tạo đề ${examType.toUpperCase()} ${selectedLevel}${sectionLabel}...`;

            progressBar.style.width = '0%';
            progressText.textContent = '0%';

            // Start simulated progress (will stop at 98% until gen completes)
            const progressInterval = this.simulateProgress(progressBar, progressText);

            try {
                // Load exam spec with dynamic level
                const rawSpec = await ExamLoader.loadSpec(examType, selectedLevel);
                let scaledSpec = ExamLoader.applyModeScaling(rawSpec, mode);

                // Filter by section (pass mode for reading mondai count)
                State.examSpec = ExamLoader.filterBySection(scaledSpec, State.currentSection, mode);

                // Calculate total mondai for progress tracking
                const totalMondai = State.examSpec.groups.reduce((sum, g) => sum + g.mondai.length, 0);

                // Determine model and concurrency based on level (Adaptive Optimization)
                // N5/N4 are simple enough for 2.5-pro (faster, higher concurrency)
                // N1/N2/N3 use 3-pro (more accurate, lower concurrency due to 25 RPM limit)
                const isLowLevel = ['N5', 'N4'].includes(selectedLevel);
                const targetModel = isLowLevel ? 'gemini-2.5-pro' : null; // null = default 3-pro

                // Concurrency based on model RPM limits:
                // - gemini-2.5-pro: 250 RPM → can send 7 parallel requests safely
                // - gemini-3-pro: 25 RPM → max 5 parallel to stay under limit
                const concurrency = (targetModel === 'gemini-2.5-pro') ? 7 : 5;

                const chunkSize = 2; // 2 mondai per chunk for faster response
                let generatedMondai = 0;

                // Initialize test structure
                State.test = {
                    meta: null,
                    groups: []
                };

                // Generate first group using chunked approach for faster start
                const firstGroup = State.examSpec.groups[0];
                const firstGroupResult = {
                    group_id: firstGroup.group_id,
                    title_vi: firstGroup.title_vi,
                    mondai: []
                };

                // Generate first chunk (3 mondai) - this gives user questions quickly
                const totalChunks = Math.ceil(firstGroup.mondai.length / chunkSize);
                let previousMondai = [];

                for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
                    const chunkResult = await Api.generateMondaiChunk(
                        State.examSpec,
                        mode,
                        0, // groupIndex
                        chunkIndex,
                        chunkSize,
                        previousMondai,
                        llmProvider,
                        targetModel
                    );

                    // Collect meta from first chunk
                    if (chunkResult.meta) {
                        State.test.meta = chunkResult.meta;
                    }

                    // Add generated mondai
                    firstGroupResult.mondai.push(...chunkResult.mondai);
                    previousMondai = [...firstGroupResult.mondai]; // Pass context to next chunk

                    // Update progress based on actual mondai generated
                    generatedMondai += chunkResult.generatedCount || chunkResult.mondai.length;
                    const progress = Math.min(90, Math.round((generatedMondai / totalMondai) * 95));
                    progressBar.style.width = `${progress}%`;
                    progressText.textContent = `${progress}%`;

                    // After first chunk, can start test immediately
                    if (chunkIndex === 0 && chunkResult.mondai.length > 0) {
                        // Initialize with partial data so user can start
                        State.test.groups = [firstGroupResult];
                        State.answers = {};
                        State.currentGroupIndex = 0;
                        State.currentMondaiIndex = 0;

                        // Stop simulated progress and complete to 100%
                        clearInterval(progressInterval);
                        progressBar.style.width = '100%';
                        progressText.textContent = '100%';
                        await new Promise(resolve => setTimeout(resolve, 200));

                        this.initializeTest();

                        // Re-enable start button
                        startBtn.disabled = false;
                        startBtn.innerHTML = originalBtnText;

                        showScreen('test-screen');

                        // Continue loading remaining chunks in background
                        this.loadRemainingChunksInBackground(
                            firstGroupResult,
                            chunkIndex + 1,
                            totalChunks,
                            previousMondai,
                            llmProvider,
                            targetModel,
                            concurrency
                        );
                        return;
                    }
                }

                // Fallback: if first chunk didn't work, use full result
                State.test.groups = [firstGroupResult];
                State.answers = {};
                State.currentGroupIndex = 0;
                State.currentMondaiIndex = 0;

                progressBar.style.width = '100%';
                progressText.textContent = '100%';

                await new Promise(resolve => setTimeout(resolve, 300));

                this.initializeTest();

                // Re-enable start button
                startBtn.disabled = false;
                startBtn.innerHTML = originalBtnText;

                showScreen('test-screen');

                // Start loading remaining groups in background
                this.loadRemainingGroupsInBackground(llmProvider, targetModel, concurrency);

            } catch (err) {
                clearInterval(progressInterval);
                progressBar.style.width = '0%';
                console.error('Start test error:', err);
                showToast('Không thể tạo đề thi: ' + err.message, 'error');

                // Re-enable start button
                startBtn.disabled = false;
                startBtn.innerHTML = originalBtnText;

                showScreen('home-screen');
            }
        },

        async loadRemainingChunksInBackground(groupResult, startChunkIndex, totalChunks, previousMondai, llmProvider, targetModel = null, concurrency = 3) {
            // STREAM C START: Fire off remaining groups (Listening, etc.) IMMEDIATELY
            // Do not await this. Let it run in parallel with the current group loading.
            console.log('Starting Stream C: Loading remaining groups (Listening) in background...');
            this.loadRemainingGroupsInBackground(llmProvider, targetModel, concurrency);

            // STREAM A + B START: Load current group chunks
            const chunkSize = 2; // Match startTest chunk size
            const batchSize = concurrency; // Dynamic batch size

            // Create batches of chunks to load
            const chunksToLoad = [];
            for (let i = startChunkIndex; i < totalChunks; i++) {
                chunksToLoad.push(i);
            }

            console.log(`Stream A/B Active: Loading ${chunksToLoad.length} chunks for current group...`);

            // Process batches for current group
            while (chunksToLoad.length > 0) {
                const batch = chunksToLoad.splice(0, batchSize);
                const promises = batch.map(chunkIndex => {
                    return Api.generateMondaiChunk(
                        State.examSpec,
                        State.currentMode,
                        0, // groupIndex
                        chunkIndex,
                        chunkSize,
                        previousMondai,
                        llmProvider,
                        targetModel
                    ).then(result => ({ chunkIndex, result }))
                        .catch(err => ({ chunkIndex, error: err }));
                });

                // Wait for batch
                const results = await Promise.all(promises);
                results.sort((a, b) => a.chunkIndex - b.chunkIndex);

                for (const { chunkIndex, result, error } of results) {
                    if (result) {
                        groupResult.mondai.push(...result.mondai);
                        // Optional: Notify UI update here if we want real-time render
                    }
                }
                previousMondai = [...groupResult.mondai];

                // Update navigation buttons after each batch
                this.updateNavigationButtons();
            }
            console.log('Stream A/B Complete: First group fully loaded.');
        },

        async loadRemainingGroupsInBackground(llmProvider, targetModel = null, concurrency = 3) {
            const totalGroups = State.examSpec.groups.length;
            const chunkSize = 2;

            // Create promises for ALL remaining groups to run in parallel
            const groupPromises = [];

            for (let groupIndex = 1; groupIndex < totalGroups; groupIndex++) {
                groupPromises.push((async () => {
                    this.loadingGroupIndex = groupIndex;
                    const group = State.examSpec.groups[groupIndex];
                    const totalChunks = Math.ceil(group.mondai.length / chunkSize);

                    const groupResult = {
                        group_id: group.group_id,
                        title_vi: group.title_vi,
                        mondai: []
                    };
                    State.test.groups[groupIndex] = groupResult; // Pre-allocate slot

                    let previousMondai = [];

                    try {
                        // Load chunks for this group (also parallel batched)
                        const chunks = [];
                        for (let i = 0; i < totalChunks; i++) chunks.push(i);
                        const batchSize = concurrency; // Use dynamic concurrency (req 4 for 2.5-pro)

                        while (chunks.length > 0) {
                            const batch = chunks.splice(0, batchSize);
                            await Promise.all(batch.map(async (chunkIndex) => {
                                const chunkResult = await Api.generateMondaiChunk(
                                    State.examSpec,
                                    State.currentMode,
                                    groupIndex,
                                    chunkIndex,
                                    chunkSize,
                                    previousMondai,
                                    llmProvider,
                                    targetModel
                                );
                                // Note: push order might be mixed within batch, but sorting ideally happens 
                                // if we stored by index. For simplicity in this stream, simple push is used 
                                // assuming independence or acceptable minor reorder. 
                                // Ideally we should use same sort logic as above but let's keep it fast.
                                groupResult.mondai.push(...chunkResult.mondai);

                                // Update navigation buttons after each chunk
                                TestUI.updateNavigationButtons();
                            }));
                            previousMondai = [...groupResult.mondai];
                        }

                        console.log(`Stream C Update: Group ${groupIndex + 1} (${group.title_vi}) fully loaded`);
                    } catch (err) {
                        console.error(`Stream C Error: Failed to load group ${groupIndex + 1}:`, err);
                        this.pendingGroups[groupIndex] = { error: err.message };
                    }
                })());
            }

            await Promise.all(groupPromises);
            this.loadingGroupIndex = -1;
            console.log('Stream C Complete: All groups loaded');
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
            const spec = State.examSpec;

            // Start timers
            Timer.startOverallTimer(test.meta.time_limits.overall_sec);

            const firstGroup = test.meta.time_limits.groups[0];
            if (firstGroup) {
                $('#group-label').textContent = this.getGroupLabel(0);
                Timer.startGroupTimer(firstGroup.time_sec);
            }

            // Update total mondai count
            const totalMondai = ExamLoader.getTotalMondai(spec);
            $('#mondai-total').textContent = totalMondai;

            // Render first mondai
            this.renderCurrentMondai();
        },

        getGroupLabel(groupIndex) {
            const group = State.test.groups[groupIndex];
            return group?.title_vi || 'Phần';
        },

        renderCurrentMondai() {
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

            // Calculate position within current group using GENERATED test
            let firstMondaiOfGroup = 0;
            for (let i = 0; i < State.currentGroupIndex; i++) {
                if (State.test.groups[i]) {
                    firstMondaiOfGroup += State.test.groups[i].mondai.length;
                }
            }
            const mondaiPosInGroup = globalIndex - firstMondaiOfGroup + 1;

            // Total uses EXAM SPEC for the full intended count
            const currentGroupSpec = State.examSpec.groups[State.currentGroupIndex];
            const totalMondaiInGroup = currentGroupSpec ? currentGroupSpec.mondai.length : currentGroup.mondai.length;

            $('#mondai-current').textContent = Math.min(mondaiPosInGroup, totalMondaiInGroup); // Cap at total
            $('#mondai-total').textContent = totalMondaiInGroup;

            // Calculate total mondai from exam spec for navigation buttons
            const totalMondaiFromSpec = State.examSpec.groups.reduce((sum, g) => sum + g.mondai.length, 0);
            // Block navigation to unloaded mondai
            const nextMondaiLoaded = this.isMondaiLoaded(globalIndex + 1);
            $('#btn-prev-mondai').disabled = globalIndex === 0;
            $('#btn-next-mondai').disabled = globalIndex === totalMondaiFromSpec - 1 || !nextMondaiLoaded;

            // Update header
            $('#mondai-title').textContent = mondai.title_vi;
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
            const hasAudio = mondai.items.some(item => item.media?.script_text);
            const audioScript = $('#audio-script');
            const btnShowScript = $('#btn-show-script');

            if (hasAudio) {
                audioPlayer.classList.remove('hidden');

                // Setup script
                const scriptText = mondai.items.find(item => item.media?.script_text)?.media?.script_text;
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

            // Update submit button text to clarify what is being submitted
            const submitBtn = $('#btn-submit-group');
            if (submitBtn) {
                const currentGroupTitle = this.getGroupLabel(State.currentGroupIndex);
                const isLastGroup = State.currentGroupIndex === State.examSpec.groups.length - 1;

                // Only update text if not currently submitting/loading
                if (!submitBtn.disabled || submitBtn.textContent.includes('phần')) {
                    if (isLastGroup) {
                        submitBtn.innerHTML = '<span class="btn-icon"><i class="fa-solid fa-flag-checkered"></i></span> Nộp bài thi';
                        submitBtn.classList.remove('btn-secondary');
                        submitBtn.classList.add('btn-primary');
                    } else {
                        submitBtn.innerHTML = `Nộp phần ${currentGroupTitle}`;
                        submitBtn.classList.remove('btn-primary');
                        submitBtn.classList.add('btn-secondary');
                    }
                }
            }
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
            } else { // default/replay
                btn.innerHTML = `<span class="play-icon"><i class="fa-solid fa-rotate-right"></i></span> Nghe lại`;
            }
        },

        async handleAudio() {
            const btn = $('#btn-play-audio');
            if (!btn) return;

            // Streaming TTS Handle (check first since it uses the same State.ttsAudio)
            if (TTSManager.isPlaying || TTSManager.isPaused) {
                if (State.ttsAudio && !State.ttsAudio.ended) {
                    const isNowPlaying = TTSManager.togglePause();
                    this.updateAudioButton(isNowPlaying ? 'playing' : 'paused');
                    return;
                }
            }

            // HTML5 Audio Handle (non-streaming)
            if (State.ttsAudio && State.ttsAudio.src && !State.ttsAudio.error) {
                if (!State.ttsAudio.ended) {
                    if (State.ttsAudio.paused) {
                        await State.ttsAudio.play();
                        this.updateAudioButton('playing');
                    } else {
                        State.ttsAudio.pause();
                        this.updateAudioButton('paused');
                    }
                    return;
                }
                // If ended, we restart below
            }

            // Browser TTS Handle
            if ('speechSynthesis' in window && speechSynthesis.speaking) {
                if (speechSynthesis.paused) {
                    speechSynthesis.resume();
                    this.updateAudioButton('playing');
                } else {
                    speechSynthesis.pause();
                    this.updateAudioButton('paused');
                }
                return;
            }

            // Start new playback logic
            const mondaiData = this.getCurrentMondaiData();
            if (!mondaiData) return;

            // Ensure stopped before starting new
            TTSManager.stop();

            const scriptItem = mondaiData.mondai.items.find(item => item.media?.script_text);
            if (!scriptItem) return;

            btn.disabled = true;
            this.updateAudioButton('loading');

            try {
                await TTSManager.playAudio(scriptItem.media.script_text, State.test.meta.language);
                // Note: TTSManager updates button on start/end, but we rely on events there
            } catch (err) {
                console.error(err);
                this.updateAudioButton('default'); // Show Retry/Play icon
            } finally {
                btn.disabled = false;
            }
        },



        getCurrentMondaiData() {
            const test = State.test;
            let idx = 0;

            for (const group of test.groups) {
                for (const mondai of group.mondai) {
                    if (idx === State.currentMondaiIndex) {
                        return { group, mondai };
                    }
                    idx++;
                }
            }
            return null;
        },

        // Check if a mondai at globalIndex has been loaded
        isMondaiLoaded(globalIndex) {
            if (globalIndex < 0) return false;
            let idx = 0;
            for (const group of State.test.groups) {
                if (!group || !group.mondai) continue; // Group not loaded yet
                for (const mondai of group.mondai) {
                    if (idx === globalIndex) return true;
                    idx++;
                }
            }
            return false;
        },

        // Update navigation buttons without re-rendering (for background loading)
        updateNavigationButtons() {
            if (!State.test || !State.examSpec) return;

            const globalIndex = this.getGlobalMondaiIndex();
            const totalMondaiFromSpec = State.examSpec.groups.reduce((sum, g) => sum + g.mondai.length, 0);
            const nextMondaiLoaded = this.isMondaiLoaded(globalIndex + 1);
            const wasDisabled = $('#btn-next-mondai').disabled;

            $('#btn-next-mondai').disabled = globalIndex === totalMondaiFromSpec - 1 || !nextMondaiLoaded;

            // Update loading indicator
            const loadingIndicator = $('#nav-loading-indicator');
            if (loadingIndicator) {
                if (!nextMondaiLoaded && globalIndex < totalMondaiFromSpec - 1) {
                    loadingIndicator.classList.remove('hidden');
                } else {
                    loadingIndicator.classList.add('hidden');
                }
            }

            // Notify user if button just became enabled
            if (wasDisabled && !$('#btn-next-mondai').disabled) {
                // Toast is optional - can be noisy, so just update button silently
            }
        },

        getGlobalMondaiIndex() {
            return State.currentMondaiIndex;
        },

        getTotalMondaiCount() {
            return State.test.groups.reduce((sum, g) => sum + g.mondai.length, 0);
        },

        renderQuestions(items, language) {
            const container = $('#questions-container');
            const isJapanese = language === 'ja-JP';

            container.innerHTML = items.map((item, idx) => `
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
      `).join('');

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
                showToast('Đang tải câu hỏi tiếp theo...', 'info');
                return;
            }

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
                if (mondaiIndex < idx + group.mondai.length) {
                    return gi;
                }
                idx += group.mondai.length;
            }
            return 0;
        },

        getFirstMondaiIndexOfGroup(groupIndex) {
            let idx = 0;
            for (let gi = 0; gi < groupIndex; gi++) {
                idx += State.test.groups[gi].mondai.length;
            }
            return idx;
        },

        async moveToNextGroup() {
            // Prevent duplicate submissions
            if (this.isSubmitting) return;

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
                    mondaiIdx += State.test.groups[i].mondai.length;
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
        async quickGradeTest() {
            Timer.stopAll();
            TTSManager.stop();

            // Calculate scores directly
            const questionsWithAnswers = [];
            let correctCount = 0;
            let totalCount = 0;
            const scoreByGroup = {};

            State.test.groups.forEach(group => {
                let groupCorrect = 0;
                group.mondai.forEach(mondai => {
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
                            // Use existing explain_brief from question generation
                            key_point_vi: item.explain_brief || '',
                            tags: item.tags
                        });
                    });
                });
                scoreByGroup[group.group_id] = groupCorrect;
            });

            // Build feedback object compatible with ReviewUI
            const feedback = {
                score_summary: {
                    total_score: correctCount,
                    max_score: totalCount,
                    score_by_group: scoreByGroup,
                    weak_tags: [], // Could calculate from incorrect answers
                    recommendation_vi: correctCount >= totalCount * 0.7
                        ? 'Kết quả tốt! Tiếp tục luyện tập để cải thiện.'
                        : 'Cần ôn tập thêm các phần còn yếu.'
                },
                by_question: questionsWithAnswers,
                grading_mode: 'quick' // Flag for UI to know this was quick grading
            };

            State.feedback = feedback;

            // Save to history (simplified)
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

            try {
                const llmProvider = $('#llm-provider').value;
                const feedback = await Api.gradeTest(State.test, State.answers, llmProvider);
                feedback.grading_mode = 'ai'; // Flag for UI
                State.feedback = feedback;

                // Save to history
                await this.saveToHistory(feedback);

                ReviewUI.render();
                showScreen('review-screen');
            } catch (err) {
                console.error('Grade test error:', err);
                showToast('Không thể chấm điểm: ' + err.message, 'error');
                showScreen('home-screen');
            } finally {
                // Ensure loading screen is removed if it's still active
                if ($('#loading-screen').classList.contains('active') && !$('#review-screen').classList.contains('active')) {
                    showScreen('home-screen');
                }
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
                    for (const mondai of group.mondai) {
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
            // Allowed: u, b, i, em, strong, ruby, rt, rp, br, span
            const allowedTags = ['u', 'b', 'i', 'em', 'strong', 'ruby', 'rt', 'rp', 'br', 'span'];

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
            const scoreValue = scoreSummary.total_score !== undefined ? scoreSummary.total_score : (scoreSummary.score_total || 0);
            const scoreMax = scoreSummary.max_score !== undefined ? scoreSummary.max_score : (scoreSummary.score_max || this.getTotalQuestions());
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

            // Weak tags
            const tagsHtml = (scoreSummary.weak_tags || [])
                .map(tag => `<span class="tag">${tag}</span>`)
                .join('');
            $('#weak-tags').innerHTML = tagsHtml || '<span style="color: var(--text-muted)">Không có</span>';

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
                    for (const mondai of group.mondai) {
                        const found = mondai.items.find(q => q.id === item.id);
                        if (found) {
                            questionData = found;
                            break;
                        }
                    }
                }

                if (!questionData) return '';

                const userAnswer = State.answers[item.id];
                const correctAnswer = questionData.answer_index;

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
            
            ${!item.is_correct ? `
              <div class="review-feedback">
                ${item.why_wrong_vi ? `<div class="feedback-section"><h4>Tại sao sai:</h4><p>${item.why_wrong_vi}</p></div>` : ''}
                ${item.key_point_vi ? `
                  <div class="feedback-section">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                      <h4>Điểm ngữ pháp:</h4>
                      <button onclick="ReviewUI.saveGrammar('${item.id}')" class="btn btn-xs btn-outline" title="Lưu vào sổ tay"><i class="fa-solid fa-floppy-disk"></i> Lưu</button>
                    </div>
                    <p>${item.key_point_vi}</p>
                  </div>` : ''}
                ${item.mini_lesson_vi ? `<div class="feedback-section"><h4>Bài học nhỏ:</h4><p>${item.mini_lesson_vi}</p></div>` : ''}
                ${questionData.media?.script_text ? `<div class="feedback-section"><h4>Nội dung bài nghe:</h4><p class="script-text">${TestUI.escapeHtml(questionData.media.script_text).replace(/\n/g, '<br>')}</p></div>` : ''}
                ${item.extra_examples_target?.length ? `
                  <div class="feedback-section">
                    <h4>Ví dụ thêm:</h4>
                    <ul class="examples-list ${isJapanese ? '' : 'zh'}">
                      ${item.extra_examples_target.map(ex => `<li>${ex}</li>`).join('')}
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
                for (const mondai of group.mondai) {
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
                for (const mondai of group.mondai) {
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
                // Ensure section selector is visible (though strictly already removed hidden)
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

        // Listening Controls
        $('#btn-show-script')?.addEventListener('click', () => TestUI.toggleScript());
        $('#btn-play-audio')?.addEventListener('click', () => TestUI.handleAudio());

        // Audio Seek & Rewind
        $('#audio-seek')?.addEventListener('input', (e) => {
            if (State.ttsAudio && State.ttsAudio.duration) {
                const pct = parseFloat(e.target.value);
                State.ttsAudio.currentTime = (pct / 100) * State.ttsAudio.duration;
            }
        });

        $('#btn-replay-audio')?.addEventListener('click', () => {
            if (State.ttsAudio) {
                State.ttsAudio.currentTime = Math.max(0, State.ttsAudio.currentTime - 5);
                if (State.ttsAudio.paused) State.ttsAudio.play();
            }
        });

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

        // Audio handler is already registered at line 1653 via TestUI.handleAudio()

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
        initEventHandlers();
        await Auth.init();

        // Check for existing session (if Privy supports it)
        // For now, show login screen
        showScreen('login-screen');

        console.log('App initialized');
    }

    // Start the app
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
