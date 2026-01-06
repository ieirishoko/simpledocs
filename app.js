/**
 * Simple Docs - Cloud Sync Version
 * 
 * Firebase Firestoreを使用したクラウド同期対応版
 * クライアントサイド暗号化 (AES-256) でプライバシーを保護
 */

// === 定数・設定 ===
const FIREBASE_CONFIG_KEY = 'simple-docs-fb-config';
const SECURE_STORAGE_KEY = 'simple-docs-secure-v1'; // ローカルキャッシュ兼用

// 初期データ構造
const INITIAL_CONTENT = {
    tabs: [
        {
            id: 'tab-ideas',
            name: 'アイデア',
            pages: [
                { id: 'page-welcome', title: 'ようこそ (Cloud)', content: 'これはクラウド同期された思考スペースです。\n\n【仕組み】\nデータはあなたのFirebaseに暗号化して保存されます。\nPCとスマホで同じ設定キーを使えば、\nどこからでも同じノートを開けます。\n\nもちろん、内容は強力に暗号化されています。', mode: 'text', updatedAt: Date.now() }
            ]
        }
    ]
};

// === 状態管理 ===
let appData = null;
let sessionKey = null; // パスワード
let currentTabId = null;
let currentPageId = null;
let db = null; // Firestoreインスタンス
let isOfflineMode = false;

// === DOM要素 ===
const els = {
    setupScreen: document.getElementById('setup-screen'),
    authScreen: document.getElementById('auth-screen'),
    appScreen: document.getElementById('app-screen'),

    // Setup
    configInput: document.getElementById('firebase-config-input'),
    saveConfigBtn: document.getElementById('save-config-btn'),
    setupError: document.getElementById('setup-error'),

    // Auth
    loginForm: document.getElementById('login-form'),
    passwordInput: document.getElementById('password-input'),
    authError: document.getElementById('auth-error'),

    // App
    tabList: document.getElementById('tab-list'),
    addTabBtn: document.getElementById('add-tab-btn'),
    currentTabName: document.getElementById('current-tab-name'),
    editTabNameBtn: document.getElementById('edit-tab-name-btn'),
    deleteTabBtn: document.getElementById('delete-tab-btn'),
    pageList: document.getElementById('page-list'),
    addPageBtn: document.getElementById('add-page-btn'),
    editorWrapper: document.getElementById('editor-wrapper'),
    emptyState: document.getElementById('empty-state'),
    docTitle: document.getElementById('doc-title'),
    docBody: document.getElementById('doc-body'),
    lastSaved: document.getElementById('last-saved'),
    logoutBtn: document.getElementById('logout-btn'),

    // Grid Setup
    gridEditor: document.getElementById('grid-editor'),
    gridRows: document.getElementById('grid-rows'),
    addRowBtn: document.getElementById('add-row-btn'),
    modeTextBtn: document.getElementById('mode-text-btn'),
    modeGridBtn: document.getElementById('mode-grid-btn'),

    // Sidebar
    sidebar: document.querySelector('.sidebar'),
    sidebarToggle: document.getElementById('sidebar-toggle')
};

// === 初期化フロー ===
function init() {
    // モバイルならサイドバーを初期状態で隠す
    if (window.innerWidth <= 768) {
        els.sidebar.classList.add('mobile-hidden');
    }

    // サイドバー開閉イベント
    els.sidebarToggle.addEventListener('click', () => {
        if (window.innerWidth <= 768) {
            els.sidebar.classList.toggle('mobile-hidden');
        } else {
            els.sidebar.classList.toggle('closed');
        }
    });

    // メインエリア（エディタ）をクリックしたら、モバイル時はサイドバーを閉じる（使いやすくする）
    els.editorWrapper.addEventListener('click', () => {
        if (window.innerWidth <= 768 && !els.sidebar.classList.contains('mobile-hidden')) {
            els.sidebar.classList.add('mobile-hidden');
        }
    });

    // 1. Firebase設定の確認
    const configRaw = localStorage.getItem(FIREBASE_CONFIG_KEY);

    if (configRaw) {
        try {
            const config = JSON.parse(configRaw);
            initializeFirebase(config);
            showAuthScreen();
        } catch (e) {
            console.error("Config Error", e);
            showSetupScreen();
        }
    } else {
        showSetupScreen();
    }

    setupEventListeners();
}

function initializeFirebase(config) {
    try {
        if (!firebase.apps.length) {
            firebase.initializeApp(config);
        }
        db = firebase.firestore();
        // オフラインキャッシュ有効化
        db.enablePersistence().catch(err => console.log("Persistence Error", err));
    } catch (e) {
        showSetupScreen();
        els.setupError.textContent = "設定が無効のようです: " + e.message;
    }
}

// === 画面遷移 ===
function showSetupScreen() {
    els.appScreen.classList.remove('active');
    els.authScreen.classList.remove('active');
    els.setupScreen.classList.add('active');
}

function showAuthScreen() {
    els.setupScreen.classList.remove('active');
    els.appScreen.classList.remove('active');
    els.authScreen.classList.add('active');

    // 表示テキスト調整
    document.querySelector('#auth-screen h1').textContent = "Cloud Login";
    document.querySelector('#auth-screen p').textContent = "クラウドデータの復号パスワードを入力";
    els.passwordInput.value = '';
    els.passwordInput.focus();
}

function unlockApp() {
    els.setupScreen.classList.remove('active');
    els.authScreen.classList.remove('active');
    els.appScreen.classList.add('active');

    renderTabs();
    if (appData.tabs && appData.tabs.length > 0) {
        switchTab(appData.tabs[0].id);
    } else {
        // データが空（新規）の場合
        appData = JSON.parse(JSON.stringify(INITIAL_CONTENT));
        renderTabs();
        switchTab(appData.tabs[0].id);
        saveData(); // 初期データ作成
    }
}

// === Setup ロジック ===
els.saveConfigBtn.addEventListener('click', () => {
    const input = els.configInput.value.trim();
    if (!input) return;

    try {
        // 入力が "const firebaseConfig = {...}" 形式か、純粋なJSONか判定して抽出
        let jsonStr = input;
        if (input.includes('=')) {
            const match = input.match(/\{[\s\S]*\}/);
            if (match) jsonStr = match[0];
        }

        // JSONとして正しいかチェック
        // ※キーにクォートがないJSオブジェクト形式の場合、JSON.parseは失敗する。簡易的な補正を試みる。
        // セキュリティ上、evalは使いたくないが、FirebaseのコピペスニペットはJSオブジェクト。
        // ここはFunctionコンストラクタでパースする（閉じたスコープで実行）
        const config = new Function("return " + jsonStr)();

        if (!config.apiKey || !config.projectId) {
            throw new Error("apiKey または projectId が見つかりません");
        }

        localStorage.setItem(FIREBASE_CONFIG_KEY, JSON.stringify(config));
        initializeFirebase(config);
        showAuthScreen();

    } catch (e) {
        els.setupError.textContent = "設定の読み込みに失敗しました。形式を確認してください。\n" + e.message;
    }
});


// === Auth & Loading ロジック ===
els.loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = els.passwordInput.value;
    if (!password) return;

    els.authError.textContent = "クラウドに接続中...";

    try {
        // Firestoreからデータ取得 ('docs' コレクションの 'main' ドキュメント固定)
        const docRef = db.collection('docs').doc('main');
        const doc = await docRef.get();

        if (doc.exists) {
            const data = doc.data();
            // パスワードハッシュ照合
            const inputHash = Security.hashPassword(password);

            if (data.auth && data.auth.passwordHash === inputHash) {
                // 復号
                const decrypted = Security.decrypt(data.encryptedData, password);
                if (decrypted) {
                    sessionKey = password;
                    appData = decrypted;
                    unlockApp();
                } else {
                    els.authError.textContent = "復号エラー: データが壊れているか、パスワードが違います（ハッシュ衝突）";
                }
            } else {
                els.authError.textContent = "パスワードが違います";
                els.passwordInput.classList.add('error');
            }
        } else {
            // 新規作成モード
            if (confirm("クラウドにデータが見つかりません。このパスワードで新しく始めますか？")) {
                sessionKey = password;
                appData = JSON.parse(JSON.stringify(INITIAL_CONTENT));
                await saveData(true); // 強制保存
                unlockApp();
            } else {
                els.authError.textContent = "キャンセルされました";
            }
        }
    } catch (err) {
        console.error(err);
        els.authError.textContent = "接続エラー: " + err.message;
        // ネットワークエラー等の場合でも、ローカルキャッシュがあればそれを開くロジックを本来は入れるべき
    }
});


// === 保存ロジック（クラウド） ===
async function saveData(force = false) {
    if (!appData || !sessionKey || !db) return;

    try {
        const encrypted = Security.encrypt(appData, sessionKey);
        const dataToSave = {
            auth: {
                passwordHash: Security.hashPassword(sessionKey)
            },
            encryptedData: encrypted,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };

        // Firestore保存
        await db.collection('docs').doc('main').set(dataToSave);
        updateLastSavedTime();

    } catch (e) {
        console.error("Save Error", e);
        els.lastSaved.textContent = "保存失敗 (オフライン?)";
    }
}

// === Crypto ユーティリティ (前回と同じ) ===
const Security = {
    hashPassword: (password) => {
        return CryptoJS.SHA256(password).toString();
    },
    encrypt: (data, password) => {
        return CryptoJS.AES.encrypt(JSON.stringify(data), password).toString();
    },
    decrypt: (encryptedString, password) => {
        try {
            const bytes = CryptoJS.AES.decrypt(encryptedString, password);
            return JSON.parse(bytes.toString(CryptoJS.enc.Utf8));
        } catch (e) {
            return null;
        }
    }
};

// === アプリロジック (View/Edit) ===
// ほぼ前回同様だが、Grid/Text切り替えなどのUI紐付けを再定義

// タブ管理
function renderTabs() {
    els.tabList.innerHTML = '';
    appData.tabs.forEach(tab => {
        const btn = document.createElement('button');
        btn.className = `tab ${tab.id === currentTabId ? 'active' : ''}`;
        btn.textContent = tab.name;
        btn.onclick = () => switchTab(tab.id);
        els.tabList.appendChild(btn);
    });
}

function switchTab(tabId) {
    currentTabId = tabId;
    renderTabs();
    const currentTab = appData.tabs.find(t => t.id === currentTabId);
    if (currentTab) {
        els.currentTabName.textContent = currentTab.name;
        renderPages(currentTab);
        if (currentTab.pages.length > 0) switchPage(currentTab.pages[0].id);
        else showEmptyState();
    }
}

els.addTabBtn.addEventListener('click', () => {
    const name = prompt("新しいタブの名前:");
    if (name) {
        const newTab = { id: 'tab-' + Date.now(), name: name, pages: [] };
        appData.tabs.push(newTab);
        renderTabs();
        switchTab(newTab.id);
        triggerAutoSave();
    }
});

els.deleteTabBtn.addEventListener('click', () => {
    if (appData.tabs.length <= 1) return alert("最後のタブは削除できません");
    if (confirm("削除しますか？")) {
        appData.tabs = appData.tabs.filter(t => t.id !== currentTabId);
        switchTab(appData.tabs[0].id);
        triggerAutoSave();
    }
});

els.editTabNameBtn.addEventListener('click', () => {
    const tab = appData.tabs.find(t => t.id === currentTabId);
    if (tab) {
        const name = prompt("名前変更:", tab.name);
        if (name) { tab.name = name; renderTabs(); els.currentTabName.textContent = name; triggerAutoSave(); }
    }
});

// ページ管理
function renderPages(tab) {
    els.pageList.innerHTML = '';
    tab.pages.forEach(page => {
        const div = document.createElement('div');
        div.className = `page-item ${page.id === currentPageId ? 'active' : ''}`;
        div.innerHTML = `<i class="ph ${page.mode === 'grid' ? 'ph-table' : 'ph-file-text'}"></i> <span>${escapeHtml(page.title || '無題')}</span>`;
        div.onclick = () => switchPage(page.id);
        els.pageList.appendChild(div);
    });
}

function switchPage(pageId) {
    currentPageId = pageId;
    const currentTab = appData.tabs.find(t => t.id === currentTabId);
    if (!currentTab) return;
    const page = currentTab.pages.find(p => p.id === pageId);
    if (page) {
        els.emptyState.classList.add('hidden');
        els.editorWrapper.style.display = 'flex';
        els.docTitle.value = page.title;
        updateEditorView(page);
        renderPages(currentTab);
    } else {
        showEmptyState();
    }
}

els.addPageBtn.addEventListener('click', () => {
    const currentTab = appData.tabs.find(t => t.id === currentTabId);
    if (!currentTab) return;
    const newPage = { id: 'page-' + Date.now(), title: '', content: '', mode: 'text', updatedAt: Date.now() };
    currentTab.pages.push(newPage);
    switchPage(newPage.id);
    els.docTitle.focus();
    triggerAutoSave();
});

function showEmptyState() {
    currentPageId = null;
    els.editorWrapper.style.display = 'none';
    els.emptyState.classList.remove('hidden');
}

// === エディタ更新処理 (Text/Grid共通) ===
let saveTimeout = null;
function triggerAutoSave() {
    const currentTab = appData.tabs.find(t => t.id === currentTabId);
    const page = currentTab ? currentTab.pages.find(p => p.id === currentPageId) : null;

    if (page) {
        page.updatedAt = Date.now();
        els.lastSaved.textContent = "保存中...";
        if (saveTimeout) clearTimeout(saveTimeout);
        saveTimeout = setTimeout(() => {
            saveData();
            if (currentTab) renderPages(currentTab); // タイトル更新反映
        }, 1000); // クラウドなので少し間隔を空ける
    }
}

function updateLastSavedTime() {
    const now = new Date();
    els.lastSaved.textContent = `Cloud Saved: ${now.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`;
}

// テキストモード
els.docTitle.addEventListener('input', () => {
    const currentTab = appData.tabs.find(t => t.id === currentTabId);
    const page = currentTab.pages.find(p => p.id === currentPageId);
    if (page) {
        page.title = els.docTitle.value;
        triggerAutoSave();
    }
});
els.docBody.addEventListener('input', () => {
    const currentTab = appData.tabs.find(t => t.id === currentTabId);
    const page = currentTab.pages.find(p => p.id === currentPageId);
    if (page && (!page.mode || page.mode === 'text')) {
        page.content = els.docBody.value;
        triggerAutoSave();
    }
});

// View切り替え
function updateEditorView(page) {
    const mode = page.mode || 'text';
    if (mode === 'text') {
        els.modeTextBtn.classList.add('active');
        els.modeGridBtn.classList.remove('active');
        els.docBody.style.display = 'block';
        els.gridEditor.classList.add('hidden');
        els.docBody.value = (typeof page.content === 'string') ? page.content : '';
    } else {
        els.modeTextBtn.classList.remove('active');
        els.modeGridBtn.classList.add('active');
        els.docBody.style.display = 'none';
        els.gridEditor.classList.remove('hidden');
        renderGridRowsFromContent(page.content);
    }
}

els.modeTextBtn.onclick = () => setPageMode('text');
els.modeGridBtn.onclick = () => setPageMode('grid');

function setPageMode(mode) {
    const currentTab = appData.tabs.find(t => t.id === currentTabId);
    const page = currentTab ? currentTab.pages.find(p => p.id === currentPageId) : null;
    if (!page || page.mode === mode) return;

    if (confirm("表示モードを切り替えますか？")) {
        page.mode = mode;
        if (mode === 'text') page.content = '';
        else page.content = '[]';
        updateEditorView(page);
        renderPages(currentTab);
        triggerAutoSave();
    }
}

// Grid ロジック
function renderGridRowsFromContent(content) {
    let rows = [];
    try { rows = JSON.parse(content); if (!Array.isArray(rows)) rows = []; } catch (e) { rows = []; }
    if (rows.length === 0) rows.push({ c1: '', c2: '', c3: '' });

    els.gridRows.innerHTML = '';
    rows.forEach((r, i) => addGridRowDOM(r, i));
}

function addGridRowDOM(rowData, index) {
    const div = document.createElement('div');
    div.className = 'grid-row';
    // Cells
    ['c1', 'c2', 'c3'].forEach(key => {
        const txt = document.createElement('textarea');
        txt.className = 'grid-cell';
        txt.rows = 1;
        txt.value = rowData[key] || '';
        txt.oninput = () => { autoResize(txt); saveGridToPage(); };
        txt.onpaste = (e) => handlePaste(e);
        div.appendChild(txt);
        setTimeout(() => autoResize(txt), 0);
    });
    // Del btn
    const btn = document.createElement('button');
    btn.className = 'row-delete-btn';
    btn.innerHTML = '<i class="ph ph-trash"></i>';
    btn.onclick = () => { div.remove(); saveGridToPage(); };
    div.appendChild(btn);

    els.gridRows.appendChild(div);
}

els.addRowBtn.onclick = () => {
    addGridRowDOM({ c1: '', c2: '', c3: '' });
    saveGridToPage();
};

function autoResize(el) {
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
}

function saveGridToPage() {
    const rows = [];
    els.gridRows.querySelectorAll('.grid-row').forEach(row => {
        const areas = row.querySelectorAll('textarea');
        rows.push({ c1: areas[0].value, c2: areas[1].value, c3: areas[2].value });
    });
    const currentTab = appData.tabs.find(t => t.id === currentTabId);
    const page = currentTab.pages.find(p => p.id === currentPageId);
    if (page) {
        page.content = JSON.stringify(rows);
        triggerAutoSave();
    }
}

function handlePaste(e) {
    const text = (e.clipboardData || window.clipboardData).getData('text');
    if (text.includes('\t') || text.includes('\n')) {
        e.preventDefault();
        const lines = text.split(/\r\n|\n|\r/).filter(l => l.trim());
        // 簡易実装: 末尾に追加してしまう
        lines.forEach(line => {
            const cols = line.split('\t');
            addGridRowDOM({ c1: cols[0] || '', c2: cols[1] || '', c3: cols[2] || '' });
        });
        saveGridToPage();
    }
}

// ユーティリティ
function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, function (m) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m];
    });
}
els.logoutBtn.addEventListener('click', () => location.reload());

init();
