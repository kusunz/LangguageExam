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

        async gradeTest(test, answers, provider) {
            return this.request('/grade-test', {
                method: 'POST',
                body: { test, answers, provider }
            });
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
                console.log('Privy config loaded:', config);
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
            this.handleAuthSuccess({ email: 'demo@example.com', token: 'demo-token' });
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

                // Check nickname
                if (State.userData && State.userData.nickname === null && !State.isDemoMode) {
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

        filterBySection(spec, section) {
            if (section === 'full') return spec;

            const filteredSpec = JSON.parse(JSON.stringify(spec));

            // Define section to mondai mapping
            const sectionMondaiMap = {
                'vocab-grammar': ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'],
                'reading': ['M8', 'M9', 'M10', 'M11', 'M12'],
                'listening': ['L1', 'L2', 'L3', 'L4', 'L5']
            };

            const allowedMondai = sectionMondaiMap[section] || [];

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
        async playAudio(text, language) {
            const ttsMode = $('#tts-mode').value;
            const statusEl = $('#audio-status');

            try {
                statusEl.textContent = 'Đang tải...';

                if (ttsMode === 'browser') {
                    await this.playBrowserTTS(text, language);
                } else {
                    try {
                        // Try server TTS first (Deepgram primary, falls back to Gemini on server)
                        const provider = ttsMode === 'auto' ? 'deepgram' : ttsMode;
                        const blob = await Api.getTts(text, language, provider);
                        await this.playBlob(blob);
                    } catch (err) {
                        console.warn('Server TTS failed, falling back to browser:', err);
                        await this.playBrowserTTS(text, language);
                    }
                }

                statusEl.textContent = '';
            } catch (err) {
                statusEl.textContent = 'Lỗi phát âm thanh';
                showToast('Không thể phát âm thanh: ' + err.message, 'error');
            }
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
                    const btn = $('#btn-play-audio');
                    if (btn) btn.innerHTML = `<span class="play-icon"><i class="fa-solid fa-rotate-right"></i></span> Nghe lại`;

                    // Reset seek
                    const seek = $('#audio-seek');
                    if (seek) seek.value = 100;
                };

                State.ttsAudio.onerror = reject;

                // Resolve promise when playback STARTS so UI is interactive
                State.ttsAudio.onplay = () => {
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
                State.ttsAudio = null;
            }
            if ('speechSynthesis' in window) {
                speechSynthesis.cancel();
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

            const progressInterval = this.simulateProgress(progressBar, progressText);

            try {
                // Load exam spec with dynamic level
                const rawSpec = await ExamLoader.loadSpec(examType, selectedLevel);
                let scaledSpec = ExamLoader.applyModeScaling(rawSpec, mode);

                // Filter by section
                State.examSpec = ExamLoader.filterBySection(scaledSpec, State.currentSection);

                // Generate FIRST GROUP only (for quick start)
                const firstGroupResult = await Api.generateGroup(State.examSpec, mode, 0, llmProvider);

                // Initialize test with first group
                State.test = {
                    meta: firstGroupResult.meta,
                    groups: [firstGroupResult] // Start with just first group
                };
                State.answers = {};
                State.currentGroupIndex = 0;
                State.currentMondaiIndex = 0;

                // Complete progress for first group
                clearInterval(progressInterval);
                progressBar.style.width = '100%';
                progressText.textContent = '100%';

                await new Promise(resolve => setTimeout(resolve, 300));

                this.initializeTest();
                showScreen('test-screen');

                // Start loading remaining groups in background
                this.loadRemainingGroupsInBackground(llmProvider);

            } catch (err) {
                clearInterval(progressInterval);
                progressBar.style.width = '0%';
                console.error('Start test error:', err);
                showToast('Không thể tạo đề thi: ' + err.message, 'error');
                showScreen('home-screen');
            }
        },

        async loadRemainingGroupsInBackground(llmProvider) {
            const totalGroups = State.examSpec.groups.length;

            for (let i = 1; i < totalGroups; i++) {
                this.loadingGroupIndex = i;
                try {
                    console.log(`Background loading group ${i + 1}/${totalGroups}...`);
                    const groupResult = await Api.generateGroup(State.examSpec, State.currentMode, i, llmProvider);
                    State.test.groups.push(groupResult);
                    console.log(`Group ${i + 1} loaded successfully`);
                } catch (err) {
                    console.error(`Failed to load group ${i + 1}:`, err);
                    // Store error for handling when user reaches this group
                    this.pendingGroups[i] = { error: err.message };
                }
            }
            this.loadingGroupIndex = -1; // Done loading
            console.log('All groups loaded');
        },

        isGroupReady(groupIndex) {
            return State.test.groups[groupIndex] !== undefined;
        },

        simulateProgress(bar, text) {
            let progress = 0;
            return setInterval(() => {
                // fast until 30%, then slower until 80%, then very slow until 90%
                let increment = 0;
                if (progress < 20) increment = 2;
                else if (progress < 60) increment = 0.5;
                else if (progress < 90) increment = 0.1;

                progress = Math.min(progress + increment, 97);
                bar.style.width = `${progress}%`;
                text.textContent = `${Math.round(progress)}%`;
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

            // Update navigation - show position within current group
            const globalIndex = this.getGlobalMondaiIndex();
            const totalMondai = this.getTotalMondaiCount();
            const currentGroup = State.test.groups[State.currentGroupIndex];
            const mondaiInGroup = currentGroup.mondai.length;
            const firstMondaiOfGroup = this.getFirstMondaiIndexOfGroup(State.currentGroupIndex);
            const mondaiPosInGroup = globalIndex - firstMondaiOfGroup + 1;

            $('#mondai-current').textContent = mondaiPosInGroup;
            $('#mondai-total').textContent = mondaiInGroup;
            $('#btn-prev-mondai').disabled = globalIndex === 0;
            $('#btn-next-mondai').disabled = globalIndex === totalMondai - 1;

            // Update header
            $('#mondai-title').textContent = mondai.title_vi;
            $('#mondai-instructions').textContent = mondai.instructions_vi || '';

            // Render passage if exists
            const passageContainer = $('#passage-container');
            const passageText = $('#passage-text');

            if (mondai.passage?.text) {
                passageContainer.classList.remove('hidden');
                passageText.textContent = mondai.passage.text;
                passageText.className = `passage-text ${isJapanese ? '' : 'zh'}`;
            } else {
                passageContainer.classList.add('hidden');
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

            // HTML5 Audio Handle
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
            const currentGroupIdx = State.currentGroupIndex;
            const nextGroupIdx = currentGroupIdx + 1;
            const totalGroups = State.examSpec.groups.length;

            if (nextGroupIdx < totalGroups) {
                // Check if next group is ready
                if (!this.isGroupReady(nextGroupIdx)) {
                    // Show loading indicator while waiting for group
                    showToast('Đang tải phần tiếp theo...', 'info');

                    // Wait for group to load (poll every 500ms)
                    while (!this.isGroupReady(nextGroupIdx) && this.loadingGroupIndex >= 0) {
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }

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
                this.submitTest();
            }
        },

        async submitTest() {
            Timer.stopAll();
            TTSManager.stop();

            showScreen('loading-screen');
            $('#loading-text').textContent = 'Đang chấm điểm...';
            $('#loading-hint').textContent = 'AI đang phân tích và đánh giá câu trả lời của bạn...';

            try {
                const llmProvider = $('#llm-provider').value;
                const feedback = await Api.gradeTest(State.test, State.answers, llmProvider);
                State.feedback = feedback;

                // Save to history
                await this.saveToHistory(feedback);

                ReviewUI.render();
                showScreen('review-screen');
            } catch (err) {
                console.error('Grade test error:', err);
                showToast('Không thể chấm điểm: ' + err.message, 'error');
                showScreen('home-screen');
            }
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

            // Add mistakes to mistake book
            const incorrectItems = feedback.by_question.filter(q => !q.is_correct);
            for (const item of incorrectItems) {
                // Find the question in test
                let questionData = null;
                for (const group of State.test.groups) {
                    for (const mondai of group.mondai) {
                        const found = mondai.items.find(q => q.id === item.id);
                        if (found) {
                            questionData = found;
                            break;
                        }
                    }
                }

                if (questionData) {
                    State.userData.mistakeBook.push({
                        date: new Date().toISOString(),
                        exam: State.currentExam,
                        question: questionData,
                        feedback: item,
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
        $('#btn-demo-login').addEventListener('click', () => Auth.loginDemo());
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
