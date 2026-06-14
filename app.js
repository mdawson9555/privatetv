/**
 * PrivateTV — Core Application Logic
 * • M3U parser  • HLS.js CORS-proxy engine  • D-Pad TV navigation
 * • localStorage persistence  • Live debug overlay
 */

'use strict';

/* ═══════════ CONFIG ═══════════ */
const PROXY = '/proxy?url=';     // Works on local Express AND Cloudflare Pages Functions
const PROXY_ENABLED = true;      // Always route streams through proxy
const MAX_RENDER = 250;          // Max channels rendered per category

const SAMPLE_M3U = `#EXTM3U
#EXTINF:-1 tvg-logo="https://upload.wikimedia.org/wikipedia/commons/e/e0/Sky_News_logo_2018.svg" group-title="News",Sky News UK
https://pub-0b29845963f443b3924f7620d8293774.r2.dev/sky-news.m3u8
#EXTINF:-1 tvg-logo="https://upload.wikimedia.org/wikipedia/commons/e/ec/France_24_logo.svg" group-title="News",France 24 English
https://static.france24.com/live/F24_EN_LO_HLS/live_tv.m3u8
#EXTINF:-1 tvg-logo="https://upload.wikimedia.org/wikipedia/commons/d/df/Deutsche_Welle_logo.svg" group-title="News",Deutsche Welle English
https://dwamdstream102.akamaized.net/hls/live/2014187/dwstream102/index.m3u8
#EXTINF:-1 tvg-logo="https://upload.wikimedia.org/wikipedia/commons/e/e5/NASA_logo.svg" group-title="Science",NASA TV
https://ntv1.nasatv.live/nasatv/nasa_hd.m3u8`;

/* ═══════════ STATE ═══════════ */
const S = {
    playlists:      [],
    activePl:       'global_iptv',
    channels:       [],
    filtered:       [],
    categories:     [],
    activeCategory: 'all',
    activeChannel:  null,
    channelIndex:   0,
    categoryIndex:  0,
    favorites:      [],

    // TV nav
    tv:          false,
    zone:        0,     // 0=cat 1=ch 2=player 3=controls
    ctrlIdx:     0,

    // player
    aspectRatios: ['contain','cover','fill'],
    aspectIdx:    0,
    qualityLevels:[],
    qualityIdx:   -1,
    retryCount:   0,
    retryMax:     3,
    retryTimer:   null,
};

/* ═══════════ DOM REFS ═══════════ */
const D = {
    // Sidebar
    sidebar:          q('#sidebar'),
    backdrop:         q('#sidebar-backdrop'),
    openSidebarBtn:   q('#open-sidebar-btn'),
    closeSidebarBtn:  q('#close-sidebar-btn'),
    playlistSelect:   q('#playlist-select'),
    manageBtn:        q('#manage-btn'),
    search:           q('#channel-search'),
    clearSearchBtn:   q('#clear-search-btn'),
    catList:          q('#category-list'),
    chList:           q('#channel-list'),
    chCount:          q('#ch-count'),

    // Player
    player:           q('#player'),
    splash:           q('#player-splash'),
    loading:          q('#player-loading'),
    loadingText:      q('#loading-text'),
    errorBox:         q('#player-error'),
    errorTitle:       q('#error-title'),
    errorDetail:      q('#error-detail'),
    retryBtn:         q('#retry-btn'),
    nextBtn:          q('#next-btn'),
    video:            q('#video'),

    // Controls
    controls:         q('#controls'),
    nowPlayingBar:    q('#now-playing-bar'),
    ctrlLogo:         q('#ctrl-logo'),
    ctrlName:         q('#ctrl-name'),
    ctrlGroup:        q('#ctrl-group'),
    livePill:         q('#live-pill'),
    ctrlCenter:       q('#ctrl-center'),
    centerPlaySvg:    q('#center-play-svg'),
    progressWrap:     q('#progress-wrap'),
    progressFill:     q('#progress-fill'),
    progressHandle:   q('#progress-handle'),
    progressTrack:    q('#progress-track'),
    timeLabel:        q('#time-label'),
    playBtn:          q('#play-btn'),
    playIcon:         q('#play-icon'),
    volBtn:           q('#vol-btn'),
    volIcon:          q('#vol-icon'),
    volSlider:        q('#vol-slider'),
    prevChBtn:        q('#prev-ch-btn'),
    nextChBtn:        q('#next-ch-btn'),
    ccBtn:            q('#cc-btn'),
    qualityBtn:       q('#quality-btn'),
    qualityLabel:     q('#quality-label'),
    debugToggleBtn:   q('#debug-toggle-btn'),
    ratioBtn:         q('#ratio-btn'),
    ratioLabel:       q('#ratio-label'),
    fsBtn:            q('#fs-btn'),
    fsIcon:           q('#fs-icon'),
    mobileFsBtn:      q('#mobile-fs-btn'),

    // Debug
    debugPanel:       q('#debug-panel'),
    debugBuf:         q('#debug-buf'),
    debugBw:          q('#debug-bw'),
    debugLevel:       q('#debug-level'),
    debugLog:         q('#debug-log'),
    debugClear:       q('#debug-clear'),

    // Modal
    modal:            q('#modal'),
    modalClose:       q('#modal-close'),
    addForm:          q('#add-form'),
    plName:           q('#pl-name'),
    plUrl:            q('#pl-url'),
    plFile:           q('#pl-file'),
    plText:           q('#pl-text'),
    plList:           q('#pl-list'),

    // Toast
    toast:            q('#toast'),
};

function q(sel) { return document.querySelector(sel); }

/* ═══════════ HLS INSTANCE ═══════════ */
let hls = null;
let controlsTimer = null;
let cursorTimer = null;
let bufInterval = null;

/* ═══════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
    loadStoredPlaylists();
    bindEvents();
    setupPlayerActivity();
    setupVideoEvents();
    setVolume(1);
    startBufMonitor();
    dlog('PrivateTV ready. Select a channel.', 'success');
    loadActivePl();
});

/* ═══════════════════════════════════════════════
   PLAYLIST STORAGE
═══════════════════════════════════════════════ */
function loadStoredPlaylists() {
    try {
        S.playlists = JSON.parse(localStorage.getItem('ptv_playlists') || '[]');
        S.favorites = JSON.parse(localStorage.getItem('ptv_fav') || '[]');
    } catch { S.playlists = []; S.favorites = []; }
    rebuildSelect();
}

function toggleFavorite(url) {
    if (S.favorites.includes(url)) {
        S.favorites = S.favorites.filter(u => u !== url);
        showToast('Removed from favorites');
    } else {
        S.favorites.push(url);
        showToast('Added to favorites');
    }
    localStorage.setItem('ptv_fav', JSON.stringify(S.favorites));
}

function savePlaylists() {
    localStorage.setItem('ptv_playlists', JSON.stringify(S.playlists));
    rebuildSelect();
}

function rebuildSelect() {
    D.playlistSelect.innerHTML =
        `<option value="global_iptv">🌍 iptv-org Global</option>
         <option value="sample">✨ Sample (News)</option>`;
    S.playlists.forEach(pl => {
        const o = document.createElement('option');
        o.value = pl.id; o.textContent = pl.name;
        D.playlistSelect.appendChild(o);
    });
    D.playlistSelect.value = S.activePl;
}

function loadActivePl() {
    if (S.activePl === 'global_iptv') {
        showLoading('Fetching global playlist…');
        dlog('Downloading iptv-org global playlist…', 'info');
        fetch('https://iptv-org.github.io/iptv/index.m3u')
            .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); })
            .then(txt => { 
                hideLoading(); 
                parsePlaylist(txt); 
                showToast('Global playlist loaded'); 
                dlog('Global playlist OK', 'success'); 
                // Auto-load & play the first channel automatically
                if (S.filtered && S.filtered.length > 0) {
                    playChannel(S.filtered[0], 0);
                }
            })
            .catch(err => {
                hideLoading();
                dlog(`Failed to fetch global: ${err.message} — falling back to sample`, 'error');
                showToast('⚠️ Fallback to Sample playlist');
                S.activePl = 'sample'; D.playlistSelect.value = 'sample';
                parsePlaylist(SAMPLE_M3U);
            });
    } else if (S.activePl === 'sample') {
        parsePlaylist(SAMPLE_M3U);
        showToast('Sample playlist loaded');
    } else {
        const pl = S.playlists.find(p => p.id === S.activePl);
        if (pl) { parsePlaylist(pl.data); showToast(`Loaded "${pl.name}"`); }
        else { S.activePl = 'sample'; D.playlistSelect.value = 'sample'; parsePlaylist(SAMPLE_M3U); }
    }
}

/* ═══════════════════════════════════════════════
   M3U PARSER
═══════════════════════════════════════════════ */
function parsePlaylist(text) {
    const lines  = text.split(/\r?\n/);
    const chs    = [];
    let meta     = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        if (line.startsWith('#EXTINF:')) {
            meta = { name: 'Unknown', group: 'General', logo: '', url: '' };
            const logoM  = line.match(/tvg-logo="([^"]*)"/i);
            const groupM = line.match(/group-title="([^"]*)"/i);
            const ci     = line.lastIndexOf(',');
            if (logoM)  meta.logo  = logoM[1].trim();
            if (groupM) meta.group = groupM[1].trim() || 'General';
            if (ci > 0) meta.name  = line.slice(ci + 1).trim();
        } else if (line.startsWith('http') && meta) {
            meta.url = line;
            chs.push(meta);
            meta = null;
        }
    }

    S.channels = chs;
    S.categories = [...new Set(chs.map(c => c.group))].sort();
    
    // Prioritize Sports category to be first
    const sportIdx = S.categories.findIndex(c => c.toLowerCase().includes('sport'));
    if (sportIdx > -1) {
        const sportCat = S.categories.splice(sportIdx, 1)[0];
        S.categories.unshift(sportCat);
    }

    S.activeCategory = 'all';
    S.channelIndex = 0;
    S.categoryIndex = 0;

    renderCategories();
    renderChannels();
    dlog(`Parsed ${chs.length} channels across ${S.categories.length} categories`, 'success');
}

/* ═══════════════════════════════════════════════
   RENDER
═══════════════════════════════════════════════ */
function renderCategories() {
    D.catList.innerHTML = '';
    const allItem = mkCatItem('all', 'all', 0);
    D.catList.appendChild(allItem);
    
    const favItem = mkCatItem('favorites', 'favorites', 1);
    D.catList.appendChild(favItem);

    S.categories.forEach((cat, i) => {
        D.catList.appendChild(mkCatItem(cat, categoryIcon(cat), i + 2));
    });
}

function mkCatItem(cat, iconType, listIdx) {
    const li = document.createElement('li');
    li.className = `cat-item${S.activeCategory === cat ? ' active' : ''}`;
    li.setAttribute('tabindex', '0');
    li.dataset.cat = cat;
    li.innerHTML = `${catSvg(iconType)}<span class="cat-item-name">${cat === 'all' ? 'All' : cat}</span>`;
    li.addEventListener('click', () => selectCategory(cat, listIdx));
    return li;
}

function categoryIcon(cat) {
    const lc = cat.toLowerCase();
    if (lc === 'favorites') return 'favorites';
    if (lc.includes('news')) return 'news';
    if (lc.includes('sport') || lc.includes('football') || lc.includes('soccer')) return 'sport';
    if (lc.includes('movie') || lc.includes('film') || lc.includes('cinema')) return 'movie';
    if (lc.includes('music')) return 'music';
    if (lc.includes('kid') || lc.includes('child') || lc.includes('cartoon')) return 'kids';
    if (lc.includes('doc') || lc.includes('science') || lc.includes('nature')) return 'doc';
    if (lc.includes('relig') || lc.includes('islam') || lc.includes('christian')) return 'relig';
    if (lc.includes('entertain')) return 'entertain';
    return 'general';
}

const SVG_ICONS = {
    all:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
    news:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
    sport:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="6"/><path d="M15.477 12.89L17 22l-5-3-5 3 1.523-9.11"/></svg>',
    movie:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/></svg>',
    music:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
    kids:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 13s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>',
    doc:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
    relig:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>',
    entertain: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>',
    general:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>',
    favorites: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>',
};

function catSvg(type) { return SVG_ICONS[type] || SVG_ICONS.general; }

function selectCategory(cat, listIdx) {
    S.activeCategory = cat;
    S.categoryIndex = listIdx;
    S.channelIndex  = 0;

    document.querySelectorAll('.cat-item').forEach((el, i) => {
        el.classList.toggle('active', el.dataset.cat === cat);
    });
    renderChannels();
}

function renderChannels() {
    const q = D.search.value.toLowerCase();
    
    let sourceChannels = S.activeCategory === 'favorites' ? S.channels.filter(ch => S.favorites.includes(ch.url)) : S.channels;

    S.filtered = sourceChannels.filter(ch => {
        const catOk = S.activeCategory === 'all' || S.activeCategory === 'favorites' || ch.group === S.activeCategory;
        const srOk  = ch.name.toLowerCase().includes(q);
        return catOk && srOk;
    });

    const total     = S.filtered.length;
    const toRender  = S.filtered.slice(0, MAX_RENDER);

    D.chCount.textContent = total > MAX_RENDER
        ? `${MAX_RENDER}/${total} channels`
        : `${total} channel${total !== 1 ? 's' : ''}`;

    D.chList.innerHTML = '';

    if (!total) {
        D.chList.innerHTML = `<li style="padding:20px;text-align:center;color:var(--text-m);font-size:.82rem">No channels found</li>`;
        return;
    }

    toRender.forEach((ch, idx) => D.chList.appendChild(mkChItem(ch, idx)));

    if (total > MAX_RENDER) {
        const li = document.createElement('li');
        li.className = 'ch-more-hint';
        li.textContent = `…${total - MAX_RENDER} more — use search to filter`;
        D.chList.appendChild(li);
    }
}

function mkChItem(ch, idx) {
    const li = document.createElement('li');
    const isActive = S.activeChannel && S.activeChannel.url === ch.url;
    li.className = `ch-item${isActive ? ' active' : ''}`;
    li.tabIndex = 0;
    li.dataset.idx = idx;

    const letter = ch.name.charAt(0).toUpperCase() || '?';
    const isFav = S.favorites.includes(ch.url);
    li.innerHTML = `
        <div class="ch-logo-wrap">
            ${ch.logo
                ? `<img class="ch-logo" src="${ch.logo}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='inline'">`
                : ''}
            <span class="ch-fallback" style="${ch.logo ? 'display:none' : ''}">${letter}</span>
        </div>
        <div class="ch-info">
            <div class="ch-name">${ch.name}</div>
            <div class="ch-group">${ch.group}</div>
        </div>
        <button class="fav-btn ${isFav ? 'active' : ''}" aria-label="Favorite">
            <svg viewBox="0 0 24 24" fill="${isFav ? 'var(--amber)' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
        </button>`;

    li.addEventListener('click', (e) => {
        const favBtn = e.target.closest('.fav-btn');
        if (favBtn) {
            toggleFavorite(ch.url);
            renderChannels();
            return;
        }
        playChannel(ch, idx);
    });
    li.addEventListener('keydown', e => {
        if (e.key === 'Enter') playChannel(ch, idx);
    });
    return li;
}

/* ═══════════════════════════════════════════════
   PLAYER ENGINE
═══════════════════════════════════════════════ */
function playChannel(ch, idx, retry = false) {
    if (!ch) return;

    S.activeChannel  = ch;
    S.channelIndex   = idx ?? S.channelIndex;
    S.retryCount     = retry ? S.retryCount : 0;
    clearTimeout(S.retryTimer);

    // Mark active in list
    document.querySelectorAll('.ch-item').forEach((el, i) => {
        el.classList.toggle('active', i === S.channelIndex);
    });

    // Update top info bar
    D.ctrlName.textContent  = ch.name;
    D.ctrlGroup.textContent = ch.group;
    D.ctrlLogo.src = ch.logo || '';
    D.ctrlLogo.style.opacity = ch.logo ? 1 : 0;
    D.nowPlayingBar.style.display = 'flex';

    // Show loading state
    showState('loading');
    D.loadingText.textContent = `Connecting to ${ch.name}…`;
    dlog(`▶ Playing: ${ch.name}`, 'info');
    dlog(`🔗 URL: ${ch.url}`, 'info');

    // Auto-close sidebar on mobile
    if (window.innerWidth <= 900) closeSidebar();

    // Stop old HLS instance
    destroyHls();
    D.video.removeAttribute('src');
    D.video.load();

    const raw = ch.url;

    // Determine stream protocol & proxy it
    const streamUrl = PROXY_ENABLED
        ? PROXY + encodeURIComponent(raw)
        : raw;

    dlog(`🔀 Stream routed through local proxy`, 'info');

    const isHlsUrl = raw.includes('.m3u8') || raw.includes('m3u8');

    if (Hls.isSupported() && isHlsUrl) {
        hls = new Hls({
            enableWorker: true,
            lowLatencyMode: true,
            maxMaxBufferLength: 30,
            backBufferLength: 10,
            manifestLoadingMaxRetry: 4,
            levelLoadingMaxRetry: 4,
            fragLoadingMaxRetry: 4,
        });

        hls.loadSource(streamUrl);
        hls.attachMedia(D.video);

        hls.on(Hls.Events.MANIFEST_LOADING, () => dlog('📡 Fetching HLS manifest…', 'info'));
        hls.on(Hls.Events.MANIFEST_PARSED, (e, data) => {
            dlog(`✅ Manifest parsed. Levels: ${data.levels.length}`, 'success');
            
            S.qualityLevels = data.levels;
            S.qualityIdx = -1;
            D.qualityLabel.textContent = 'Auto';
            if (data.levels.length > 1) {
                D.qualityBtn.classList.remove('hidden');
            } else {
                D.qualityBtn.classList.add('hidden');
            }
            
            checkCCAvailability();
            showState('playing');
            D.video.play().catch(err => {
                dlog(`⚠️ Autoplay blocked — tap Play to start. (${err.name})`, 'warning');
                showState('paused');
            });
        });

        hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => {
            checkCCAvailability();
        });

        hls.on(Hls.Events.LEVEL_LOADED, (e, d) => {
            const live = d.details.live;
            D.livePill.style.display = live ? 'flex' : 'none';
            D.progressWrap.classList.toggle('hidden', !!live);
            if (D.debugLevel) D.debugLevel.textContent = `${d.level}`;
            dlog(`📶 Level ${d.level} loaded | Live: ${live}`, 'success');
        });

        hls.on(Hls.Events.LEVEL_SWITCHING, (e, d) => {
            dlog(`🔄 Quality switching → level ${d.level}`, 'info');
        });

        hls.on(Hls.Events.FRAG_LOADED, () => {
            // First fragment loaded — good sign
            updatePlayIcon(false); // will be updated by 'playing' event
        });

        hls.on(Hls.Events.ERROR, (e, data) => {
            dlog(`❌ HLS ${data.fatal ? 'FATAL' : 'non-fatal'}: ${data.type} / ${data.details}`, data.fatal ? 'error' : 'warning');
            if (data.fatal) {
                handleStreamError(data.type, data.details, ch, idx);
            }
        });
    } else if (D.video.canPlayType('application/vnd.apple.mpegurl') && isHlsUrl) {
        // Native HLS (Safari/iOS) — proxy still works
        dlog('🍎 Using native HLS (Safari/iOS)', 'info');
        D.video.src = streamUrl;
        D.video.load();
        D.video.play().catch(err => dlog(`⚠️ Autoplay blocked: ${err.name}`, 'warning'));
    } else {
        // Generic video (mp4 etc.)
        dlog('▶ Loading as generic video', 'info');
        D.video.src = streamUrl;
        D.video.load();
        D.video.play().catch(err => dlog(`⚠️ Autoplay blocked: ${err.name}`, 'warning'));
    }
}

function handleStreamError(type, detail, ch, idx) {
    if (S.retryCount < S.retryMax) {
        S.retryCount++;
        const wait = S.retryCount * 2000;
        dlog(`🔄 Retry ${S.retryCount}/${S.retryMax} in ${wait/1000}s…`, 'warning');
        D.loadingText.textContent = `Retry ${S.retryCount}/${S.retryMax}…`;
        showState('loading');
        S.retryTimer = setTimeout(() => playChannel(ch, idx, true), wait);
    } else {
        dlog('🔴 Max retries reached. Stream unavailable.', 'error');
        D.errorTitle.textContent  = 'Stream Unavailable';
        D.errorDetail.textContent = `${detail} — This stream may be geo-blocked, offline, or CORS-restricted.`;
        showState('error');
        destroyHls();
    }
}

function destroyHls() {
    if (hls) { hls.destroy(); hls = null; }
}

/* ─── Player state display ─── */
function showState(state) {
    D.splash.classList.add('hidden');
    D.loading.classList.add('hidden');
    D.errorBox.classList.add('hidden');

    if (state === 'loading') D.loading.classList.remove('hidden');
    if (state === 'error')   D.errorBox.classList.remove('hidden');
    // 'playing' / 'paused' = all hidden, video element visible
}

function showLoading(msg) {
    showState('loading');
    if (msg) D.loadingText.textContent = msg;
}
function hideLoading() { D.loading.classList.add('hidden'); }

/* ═══════════════════════════════════════════════
   VIDEO EVENT HOOKS
═══════════════════════════════════════════════ */
function setupVideoEvents() {
    const v = D.video;

    v.addEventListener('playing',   () => { showState('playing'); updatePlayIcon(true); dlog('🟢 Playing', 'success'); showControls(); });
    v.addEventListener('pause',     () => { updatePlayIcon(false); showControls(); dlog('⏸ Paused', 'warning'); });
    v.addEventListener('waiting',   () => dlog('⏳ Buffering…', 'warning'));
    v.addEventListener('stalled',   () => dlog('⚠️ Network stalled', 'warning'));
    v.addEventListener('ended',     () => { dlog('⏹ Stream ended', 'info'); skipToNext(); });
    v.addEventListener('loadstart', () => dlog('🎥 Load started', 'info'));

    v.addEventListener('error', () => {
        const err = v.error;
        const msgs = {
            1: 'Aborted',
            2: 'Network error (possibly HTTP blocked on HTTPS)',
            3: 'Decoding error (unsupported codec)',
            4: 'Source not supported / CORS blocked',
        };
        const msg = err ? (msgs[err.code] || 'Unknown') : 'Unknown';
        dlog(`❌ Video error: ${msg}`, 'error');
        if (S.activeChannel) {
            handleStreamError('media', msg, S.activeChannel, S.channelIndex);
        }
    });

    v.addEventListener('timeupdate', updateProgress);
    if (v.textTracks) {
        v.textTracks.addEventListener('addtrack', checkCCAvailability);
    }
    v.volume = 1;
}

/* ─── Progress / Time ─── */
function updateProgress() {
    const v = D.video;
    if (!v.duration || isNaN(v.duration)) return;
    const pct = (v.currentTime / v.duration) * 100;
    D.progressFill.style.width = `${pct}%`;
    D.progressHandle.style.left = `${pct}%`;
    D.timeLabel.textContent = `${fmt(v.currentTime)} / ${fmt(v.duration)}`;
}

function fmt(s) {
    const m = Math.floor(s / 60), ss = Math.floor(s % 60);
    return `${m}:${ss.toString().padStart(2, '0')}`;
}

/* ─── Controls hide/show ─── */
let _csTimer = null;
function showControls() {
    D.player.classList.add('ctrl-visible');
    D.player.classList.remove('cursor-hidden');
    clearTimeout(_csTimer);
    if (!D.video.paused) {
        _csTimer = setTimeout(hideControls, 3500);
    }
}
function hideControls() {
    D.player.classList.remove('ctrl-visible');
    D.player.classList.add('cursor-hidden');
}

function setupPlayerActivity() {
    ['mousemove','mousedown','touchstart'].forEach(ev => {
        D.player.addEventListener(ev, showControls, { passive: true });
    });
}

/* ─── Play / Pause ─── */
function togglePlay() {
    if (!S.activeChannel) return;
    if (D.video.paused) D.video.play().catch(() => {});
    else D.video.pause();
}

function updatePlayIcon(isPlaying) {
    const playPoly = '<polygon points="5 3 19 12 5 21 5 3"/>';
    const pauseRect = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
    const centerPoly = '<polygon points="5 3 19 12 5 21 5 3"/>';
    const centerPause = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
    D.playIcon.innerHTML = isPlaying ? pauseRect : playPoly;
    D.centerPlaySvg.innerHTML = isPlaying ? centerPause : centerPoly;
}

/* ─── Volume ─── */
function setVolume(val) {
    val = Math.max(0, Math.min(1, val));
    D.video.volume = val;
    D.volSlider.value = val;
    updateVolIcon(val);
}
function toggleMute() {
    if (D.video.muted) { D.video.muted = false; updateVolIcon(D.video.volume); }
    else { D.video.muted = true; updateVolIcon(0); }
}
function updateVolIcon(val) {
    if (val === 0 || D.video.muted) {
        D.volIcon.innerHTML = `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>`;
    } else if (val < 0.5) {
        D.volIcon.innerHTML = `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>`;
    } else {
        D.volIcon.innerHTML = `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>`;
    }
}

/* ─── Aspect ratio ─── */
function cycleAspect() {
    S.aspectIdx = (S.aspectIdx + 1) % S.aspectRatios.length;
    const r = S.aspectRatios[S.aspectIdx];
    D.video.style.objectFit = r;
    const labels = { contain: 'Fit', cover: 'Fill', fill: 'Stretch' };
    D.ratioLabel.textContent = labels[r] || 'Fit';
    showToast(`Aspect: ${labels[r]}`);
}

/* ─── Quality Selector ─── */
function cycleQuality() {
    if (!hls || S.qualityLevels.length <= 1) return;
    
    S.qualityIdx++;
    if (S.qualityIdx >= S.qualityLevels.length) {
        S.qualityIdx = -1; // back to Auto
    }
    
    hls.currentLevel = S.qualityIdx;
    
    if (S.qualityIdx === -1) {
        D.qualityLabel.textContent = 'Auto';
        showToast('Quality: Auto (Adaptive)');
    } else {
        const level = S.qualityLevels[S.qualityIdx];
        const res = level.height ? `${level.height}p` : `${Math.round(level.bitrate / 1000)}k`;
        D.qualityLabel.textContent = res;
        showToast(`Quality: ${res}`);
    }
}

/* ─── Captions ─── */
function checkCCAvailability() {
    let hasCC = false;
    if (hls && hls.subtitleTracks && hls.subtitleTracks.length > 0) hasCC = true;
    if (D.video.textTracks && D.video.textTracks.length > 0) {
        for (let i = 0; i < D.video.textTracks.length; i++) {
            // Ignore default injected metadata tracks from some browsers
            if (D.video.textTracks[i].kind === 'subtitles' || D.video.textTracks[i].kind === 'captions') {
                hasCC = true;
                break;
            }
        }
    }
    
    if (hasCC) {
        D.ccBtn.classList.remove('hidden');
    } else {
        D.ccBtn.classList.add('hidden');
        D.ccBtn.classList.remove('active');
    }
}

function toggleCC() {
    let turnedOn = false;
    
    if (hls && hls.subtitleTracks && hls.subtitleTracks.length > 0) {
        if (hls.subtitleTrack === -1) {
            hls.subtitleTrack = 0;
            turnedOn = true;
        } else {
            hls.subtitleTrack = -1;
        }
    } else if (D.video.textTracks && D.video.textTracks.length > 0) {
        let anyShowing = false;
        for (let i = 0; i < D.video.textTracks.length; i++) {
            if (D.video.textTracks[i].mode === 'showing') anyShowing = true;
        }
        
        for (let i = 0; i < D.video.textTracks.length; i++) {
            const track = D.video.textTracks[i];
            if (anyShowing) {
                track.mode = 'hidden';
            } else if (track.kind === 'subtitles' || track.kind === 'captions') {
                track.mode = 'showing';
                turnedOn = true;
            }
        }
    } else {
        showToast('No subtitles available');
        return;
    }

    D.ccBtn.classList.toggle('active', turnedOn);
    showToast(`Captions ${turnedOn ? 'ON' : 'OFF'}`);
}

/* ─── Fullscreen ─── */
function toggleFs(el = D.player) {
    if (!document.fullscreenElement) {
        el.requestFullscreen().catch(() => {});
    } else {
        document.exitFullscreen().catch(() => {});
    }
}
document.addEventListener('fullscreenchange', () => {
    const isFs = !!document.fullscreenElement;
    D.fsIcon.innerHTML = isFs
        ? `<path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 0 2-2h3M3 16h3a2 2 0 0 0 2 2v3"/>`
        : `<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>`;
});

/* ─── Channel skip ─── */
function skipToPrev() {
    if (!S.filtered.length) return;
    S.channelIndex = (S.channelIndex - 1 + S.filtered.length) % S.filtered.length;
    playChannel(S.filtered[S.channelIndex], S.channelIndex);
}
function skipToNext() {
    if (!S.filtered.length) return;
    S.channelIndex = (S.channelIndex + 1) % S.filtered.length;
    playChannel(S.filtered[S.channelIndex], S.channelIndex);
}

/* ═══════════════════════════════════════════════
   SIDEBAR HELPERS
═══════════════════════════════════════════════ */
function openSidebar()  { D.sidebar.classList.add('open'); D.backdrop.classList.add('open'); }
function closeSidebar() { D.sidebar.classList.remove('open'); D.backdrop.classList.remove('open'); }

/* ═══════════════════════════════════════════════
   MODAL HELPERS
═══════════════════════════════════════════════ */
function openModal()  { D.modal.classList.add('open'); D.modal.setAttribute('aria-hidden','false'); renderPlList(); }
function closeModal() { D.modal.classList.remove('open'); D.modal.setAttribute('aria-hidden','true'); }

function renderPlList() {
    if (!S.playlists.length) {
        D.plList.innerHTML = '<li class="pl-empty">No saved playlists</li>';
        return;
    }
    D.plList.innerHTML = '';
    S.playlists.forEach(pl => {
        const cnt = (pl.data.match(/#EXTINF/g) || []).length;
        const li = document.createElement('li');
        li.className = 'pl-item';
        li.innerHTML = `
            <div class="pl-item-info">
                <span class="pl-item-name">${pl.name}</span>
                <span class="pl-item-meta">${cnt} channels</span>
            </div>
            <button class="pl-del-btn" data-id="${pl.id}" aria-label="Delete ${pl.name}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
            </button>`;
        li.querySelector('.pl-del-btn').addEventListener('click', () => {
            S.playlists = S.playlists.filter(p => p.id !== pl.id);
            savePlaylists();
            if (S.activePl === pl.id) { S.activePl = 'global_iptv'; D.playlistSelect.value = 'global_iptv'; loadActivePl(); }
            renderPlList();
            showToast('Playlist deleted');
        });
        D.plList.appendChild(li);
    });
}

/* ═══════════════════════════════════════════════
   DEBUG / LOG SYSTEM
═══════════════════════════════════════════════ */
function dlog(msg, type = 'info') {
    if (!D.debugLog) return;
    const ts = new Date().toLocaleTimeString();
    const el = document.createElement('div');
    el.className = `dlog ${type}`;
    el.innerHTML = `<span class="ts">[${ts}]</span> ${msg}`;
    D.debugLog.appendChild(el);
    while (D.debugLog.children.length > 50) D.debugLog.removeChild(D.debugLog.firstChild);
    D.debugLog.scrollTop = D.debugLog.scrollHeight;
}

function startBufMonitor() {
    bufInterval = setInterval(() => {
        const v = D.video;
        let buf = 0;
        if (v.buffered && v.buffered.length > 0) {
            for (let i = 0; i < v.buffered.length; i++) {
                if (v.currentTime >= v.buffered.start(i) && v.currentTime <= v.buffered.end(i)) {
                    buf = v.buffered.end(i) - v.currentTime;
                    break;
                }
            }
        }
        D.debugBuf.textContent = `${buf.toFixed(1)}s`;

        if (hls && hls.bandwidthEstimate) {
            const mbps = hls.bandwidthEstimate / 1e6;
            D.debugBw.textContent = `${mbps.toFixed(2)} Mbps`;
        }
    }, 1000);
}

/* ═══════════════════════════════════════════════
   TV D-PAD NAVIGATION
═══════════════════════════════════════════════ */
const CTRL_BTNS = () => [D.playBtn, D.volBtn, D.prevChBtn, D.nextChBtn, D.ratioBtn, D.fsBtn];

function handleKey(e) {
    const tag = document.activeElement?.tagName;
    const inInput = ['INPUT','TEXTAREA','SELECT'].includes(tag);
    const modalOpen = D.modal.classList.contains('open');

    if (modalOpen) { if (e.key === 'Escape') closeModal(); return; }

    // Quick shortcuts (always active, not in inputs)
    if (!inInput) {
        if (e.key === 'f' || e.key === 'F') { toggleFs(); e.preventDefault(); return; }
        if (e.key === 'm' || e.key === 'M') { toggleMute(); e.preventDefault(); return; }
        if (e.key === ' ')                  { togglePlay(); e.preventDefault(); return; }
        if (e.key === 'ArrowRight' && S.zone === 1 && e.altKey) { skipToNext(); return; }
    }

    const navKeys = ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Enter','Escape','Backspace'];
    if (!navKeys.includes(e.key)) return;
    if (e.key !== 'Backspace') e.preventDefault();

    S.tv = true;

    if (inInput && document.activeElement === D.search) {
        if (e.key === 'ArrowDown') { D.search.blur(); S.zone = 1; focusCh(0); }
        if (e.key === 'Enter') D.search.blur();
        return;
    }

    switch (S.zone) {
        case 0: navCat(e.key); break;
        case 1: navCh(e.key);  break;
        case 2: navPlayer(e.key); break;
        case 3: navCtrl(e.key);  break;
    }
}

function navCat(key) {
    const items = [...D.catList.querySelectorAll('.cat-item')];
    if (!items.length) return;
    if (key === 'ArrowDown') { S.categoryIndex = Math.min(S.categoryIndex + 1, items.length - 1); focusCatEl(items); }
    if (key === 'ArrowUp')   { S.categoryIndex = Math.max(S.categoryIndex - 1, 0); focusCatEl(items); }
    if (key === 'ArrowRight') { S.zone = 1; focusCh(0); }
    if (key === 'Enter') {
        const el = items[S.categoryIndex];
        selectCategory(el.dataset.cat, S.categoryIndex);
        S.zone = 1; S.channelIndex = 0; focusCh(0);
    }
}
function focusCatEl(items) {
    items.forEach(el => el.classList.remove('tv-focus'));
    const t = items[S.categoryIndex];
    t.classList.add('tv-focus'); t.focus();
    t.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function navCh(key) {
    const items = [...D.chList.querySelectorAll('.ch-item')];
    if (!items.length) return;
    if (key === 'ArrowDown') { S.channelIndex = Math.min(S.channelIndex + 1, items.length - 1); focusCh(S.channelIndex); }
    if (key === 'ArrowUp') {
        if (S.channelIndex === 0) { D.search.focus(); return; }
        S.channelIndex--; focusCh(S.channelIndex);
    }
    if (key === 'ArrowLeft')  { S.zone = 0; focusCatEl([...D.catList.querySelectorAll('.cat-item')]); }
    if (key === 'ArrowRight') { S.zone = 2; D.player.focus(); D.player.classList.add('tv-focused'); }
    if (key === 'Enter') {
        const ch = S.filtered[S.channelIndex];
        if (ch) playChannel(ch, S.channelIndex);
    }
}
function focusCh(idx) {
    const items = [...D.chList.querySelectorAll('.ch-item')];
    items.forEach(el => el.classList.remove('tv-focus'));
    S.channelIndex = Math.min(idx, items.length - 1);
    const t = items[S.channelIndex];
    if (!t) return;
    t.classList.add('tv-focus'); t.focus();
    t.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function navPlayer(key) {
    if (key === 'ArrowLeft')  { S.zone = 1; D.player.classList.remove('tv-focused'); focusCh(S.channelIndex); }
    if (key === 'ArrowDown')  { S.zone = 3; S.ctrlIdx = 0; showControls(); focusCtrl(0); }
    if (key === 'Enter')      { togglePlay(); }
}

function navCtrl(key) {
    const btns = CTRL_BTNS();
    if (key === 'ArrowUp') { S.zone = 2; btns.forEach(b => b.classList.remove('tv-focus')); hideControls(); D.player.focus(); }
    if (key === 'ArrowRight') { S.ctrlIdx = (S.ctrlIdx + 1) % btns.length; focusCtrl(S.ctrlIdx); }
    if (key === 'ArrowLeft')  { S.ctrlIdx = (S.ctrlIdx - 1 + btns.length) % btns.length; focusCtrl(S.ctrlIdx); }
    if (key === 'Enter') btns[S.ctrlIdx]?.click();
    if (key === 'Escape' || key === 'Backspace') { S.zone = 2; btns.forEach(b => b.classList.remove('tv-focus')); }
}
function focusCtrl(idx) {
    const btns = CTRL_BTNS();
    btns.forEach(b => b.classList.remove('tv-focus'));
    btns[idx]?.classList.add('tv-focus');
    btns[idx]?.focus();
}

/* ═══════════════════════════════════════════════
   EVENT BINDINGS
═══════════════════════════════════════════════ */
function bindEvents() {
    // Sidebar
    D.openSidebarBtn.addEventListener('click', openSidebar);
    D.closeSidebarBtn.addEventListener('click', closeSidebar);
    D.backdrop.addEventListener('click', closeSidebar);

    // Playlist select
    D.playlistSelect.addEventListener('change', e => {
        S.activePl = e.target.value;
        destroyHls();
        D.video.removeAttribute('src');
        D.splash.classList.remove('hidden');
        loadActivePl();
    });

    // Manage playlists
    D.manageBtn.addEventListener('click', openModal);
    D.modalClose.addEventListener('click', closeModal);
    D.modal.addEventListener('click', e => { if (e.target === D.modal) closeModal(); });

    // Modal tabs
    document.querySelectorAll('.mtab[data-tab]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.mtab[data-tab]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
        });
    });

    // Import method radios
    document.querySelectorAll('[name="method"]').forEach(r => {
        r.addEventListener('change', e => {
            document.querySelectorAll('.mtab-radio').forEach(l => l.classList.remove('active'));
            r.parentElement.classList.add('active');
            document.querySelectorAll('.mpane').forEach(p => p.classList.remove('active'));
            document.getElementById(`mpane-${e.target.value}`).classList.add('active');
        });
    });

    // Add playlist form
    D.addForm.addEventListener('submit', e => {
        e.preventDefault();
        const name   = D.plName.value.trim();
        const method = document.querySelector('[name="method"]:checked')?.value;

        if (method === 'url') {
            const url = D.plUrl.value.trim();
            if (!url) return;
            showToast('⏳ Downloading playlist…');
            dlog(`Fetching playlist URL: ${url}`, 'info');
            fetch(url)
                .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); })
                .then(txt => { addPl(name, txt, url); })
                .catch(err => {
                    dlog(`URL fetch failed: ${err.message}`, 'error');
                    showToast('❌ URL blocked (CORS). Try File or Paste method.');
                });
        } else if (method === 'file') {
            const file = D.plFile.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = ev => addPl(name, ev.target.result);
            reader.readAsText(file);
        } else if (method === 'paste') {
            const txt = D.plText.value.trim();
            if (!txt.includes('#EXTM3U')) { showToast('❌ Invalid M3U (missing #EXTM3U header)'); return; }
            addPl(name, txt);
        }
    });

    function addPl(name, data, url = '') {
        if (!data.includes('#EXTM3U')) { showToast('❌ Invalid M3U content'); return; }
        const id = 'pl_' + Date.now();
        S.playlists.push({ id, name, data, url });
        savePlaylists();
        S.activePl = id; D.playlistSelect.value = id;
        parsePlaylist(data);
        closeModal();
        showToast(`✅ "${name}" saved & loaded`);
    }

    // Player controls
    D.playBtn.addEventListener('click', togglePlay);
    D.volBtn.addEventListener('click', toggleMute);
    D.volSlider.addEventListener('input', e => setVolume(parseFloat(e.target.value)));
    D.volSlider.addEventListener('mouseenter', () => D.volSlider.classList.add('expanded'));
    D.volSlider.addEventListener('mouseleave', () => D.volSlider.classList.remove('expanded'));
    D.prevChBtn.addEventListener('click', skipToPrev);
    D.nextChBtn.addEventListener('click', skipToNext);
    D.ccBtn.addEventListener('click', toggleCC);
    D.qualityBtn.addEventListener('click', cycleQuality);
    D.ratioBtn.addEventListener('click', cycleAspect);
    D.fsBtn.addEventListener('click', () => toggleFs());
    D.mobileFsBtn.addEventListener('click', () => toggleFs());

    D.ctrlCenter.addEventListener('click', togglePlay);
    D.player.addEventListener('dblclick', () => toggleFs());

    // Debug
    D.debugToggleBtn.addEventListener('click', e => {
        e.stopPropagation();
        D.debugPanel.classList.toggle('hidden');
    });
    D.debugClear.addEventListener('click', e => {
        e.stopPropagation();
        D.debugLog.innerHTML = '';
        dlog('Log cleared', 'info');
    });

    // Error state buttons
    D.retryBtn.addEventListener('click', () => {
        if (S.activeChannel) {
            S.retryCount = 0;
            playChannel(S.activeChannel, S.channelIndex);
        }
    });
    D.nextBtn.addEventListener('click', skipToNext);

    // Search
    D.search.addEventListener('input', () => {
        D.clearSearchBtn.style.display = D.search.value ? 'flex' : 'none';
        renderChannels();
        S.channelIndex = 0;
    });
    D.clearSearchBtn.addEventListener('click', () => {
        D.search.value = ''; D.clearSearchBtn.style.display = 'none';
        renderChannels();
    });

    // Progress track click to seek
    D.progressTrack.addEventListener('click', e => {
        if (D.video.duration) {
            const rect = D.progressTrack.getBoundingClientRect();
            const pct  = (e.clientX - rect.left) / rect.width;
            D.video.currentTime = pct * D.video.duration;
        }
    });

    // Keyboard
    window.addEventListener('keydown', handleKey);

    // Deactivate TV mode on mouse
    window.addEventListener('mousedown', () => {
        if (S.tv) {
            S.tv = false;
            document.querySelectorAll('.tv-focus').forEach(el => el.classList.remove('tv-focus'));
            D.player.classList.remove('tv-focused');
        }
    });
}

/* ═══════════════════════════════════════════════
   TOAST
═══════════════════════════════════════════════ */
let _toastTimer = null;
function showToast(msg) {
    D.toast.textContent = msg;
    D.toast.classList.add('show');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => D.toast.classList.remove('show'), 3000);
}
