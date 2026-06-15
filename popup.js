'use strict';

// ── 상수 ─────────────────────────────────────────────────────────────────────

const CARD_COMPANIES = [
  '삼성카드', '신한카드', 'KB국민카드', '현대카드', '롯데카드',
  '우리카드', '하나카드', 'NH농협카드', 'BC카드',
  '씨티카드', '전북카드', '광주카드', '제주카드', '수협카드',
];

// 카드사별 동의어 — background.js 카드 매칭에서 사용 (chrome.storage 에 함께 저장)
// 페이지에 표시되는 카드사 명칭이 등록명과 다를 때 인식 보조용
const CARD_ALIASES = {
  'BC카드':         ['BC', '비씨', 'BCCARD'],

            'BC카드':         ['BC', '비씨', 'BCCARD', 'NH농협비씨', '기업BC','기업BC카드', 'NH농협비씨카드'],
            'NH농협카드':     ['농협카드', 'NH농협'],
            '기업BC카드':     ['기업BC', '기업비씨'],

};

// 카드 배지 색상 팔레트 (카드 ID 해시로 배분)
const BADGE_COLORS = [
  '#1a3a6b', '#2b7a3e', '#9c3c00', '#6a1b9a',
  '#00695c', '#c62828', '#283593', '#4e342e',
];

// ── 앱 상태 ──────────────────────────────────────────────────────────────────

let allCards        = [];   // { id, alias, company, lastFour }[]
let extractSettings = {     // 추출 실행 탭의 설정
  selectedCardIds: [],
  periodMode: 'this-month',
  customStart: '',
  customEnd: '',
  allCaptureMode: false,
};
let formMode    = 'add';    // 'add' | 'edit'
let formEditId  = null;     // 수정 중인 카드 ID

// ── 초기화 ───────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  buildCompanyOptions();
  await loadAll();
  bindEvents();
  listenContentScriptMessages();
  switchTab('cards');         // 기본 탭: 카드 관리
});

function buildCompanyOptions() {
  const sel = document.getElementById('f-company');
  CARD_COMPANIES.forEach(name => {
    const opt = document.createElement('option');
    opt.value = opt.textContent = name;
    sel.appendChild(opt);
  });
}

async function loadAll() {
  try {
    const data = await chrome.storage.local.get(['cards', 'extractSettings']);

    allCards = data.cards || [];
    if (data.extractSettings) {
      extractSettings = { ...extractSettings, ...data.extractSettings };
    }

    renderCardList();
    renderExtractTab();
    restorePeriodUI();
  } catch (err) {
    console.error('[Popup] 로드 실패:', err);
  }
}

// ── 이벤트 바인딩 ─────────────────────────────────────────────────────────────

function bindEvents() {
  // 탭 전환
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // 카드 관리 탭
  document.getElementById('btn-add-card').addEventListener('click', openAddForm);
  document.getElementById('btn-form-save').addEventListener('click', handleFormSave);
  document.getElementById('btn-form-cancel').addEventListener('click', closeForm);

  // 숫자만 입력
  document.getElementById('f-last-four').addEventListener('input', e => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
  });
  document.getElementById('f-last-four').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleFormSave();
  });

  // 추출 실행 탭 – 전체 선택 토글
  document.getElementById('btn-select-all').addEventListener('click', toggleSelectAll);

  // 기간 라디오 변경
  document.querySelectorAll('input[name="period"]').forEach(radio => {
    radio.addEventListener('change', () => {
      extractSettings.periodMode = radio.value;
      document.getElementById('custom-date-range').hidden = (radio.value !== 'custom');
      saveExtractSettings();
    });
  });

  // 직접 설정 날짜 변경
  document.getElementById('date-start').addEventListener('change', e => {
    extractSettings.customStart = e.target.value;
    saveExtractSettings();
  });
  document.getElementById('date-end').addEventListener('change', e => {
    extractSettings.customEnd = e.target.value;
    saveExtractSettings();
  });

  // 추출 버튼
  document.getElementById('btn-extract').addEventListener('click', handleExtract);

  // 전체 캡처 모드 토글
  document.getElementById('toggle-all-capture').addEventListener('change', e => {
    extractSettings.allCaptureMode = e.target.checked;
    saveExtractSettings();
    _applyAllCaptureUI(e.target.checked);
    refreshExtractButton();
  });

  // 중지 버튼
  document.getElementById('btn-stop').addEventListener('click', async () => {
    const btn = document.getElementById('btn-stop');
    btn.disabled = true;
    btn.textContent = '중지 요청 중...';
    await chrome.storage.local.set({ wmStopRequested: true });
    showStatus('중지 요청됨. 현재 영수증 처리 후 중단됩니다.', 'warning');
  });
}

// content.js → background → popup 방향 상태 메시지 수신
function listenContentScriptMessages() {
  chrome.runtime.onMessage.addListener(msg => {
    if (msg.action === 'STATUS_UPDATE') {
      showStatus(msg.text, msg.statusType || 'info');
      if (msg.statusType === 'success' || msg.statusType === 'error' || msg.statusType === 'warning') {
        setExtractLoading(false);
      }
    }
  });
}

// ── 탭 전환 ──────────────────────────────────────────────────────────────────

function switchTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    const active = btn.dataset.tab === tabName;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });

  document.querySelectorAll('.tab-panel').forEach(panel => {
    const active = panel.id === `tab-${tabName}`;
    panel.classList.toggle('active', active);
    panel.hidden = !active;
  });

  // 추출 탭 진입 시 카드 체크박스 최신 상태로 갱신
  if (tabName === 'extract') {
    renderExtractTab();
    restorePeriodUI();
  }
}

// ── 카드 관리 탭 렌더링 ──────────────────────────────────────────────────────

function renderCardList() {
  const container = document.getElementById('card-list');

  if (allCards.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">&#9673;</div>
        <div>등록된 카드가 없습니다.</div>
        <div>아래 버튼을 눌러 카드를 추가하세요.</div>
      </div>`;
    return;
  }

  container.innerHTML = '';
  allCards.forEach(card => {
    container.appendChild(buildCardItem(card));
  });
}

function buildCardItem(card) {
  const color = badgeColor(card.id);
  const item = document.createElement('div');
  item.className = 'card-item';
  item.dataset.id = card.id;
  item.innerHTML = `
    <div class="card-item-badge" style="background:${color}">${badgeLetter(card.alias)}</div>
    <div class="card-item-info">
      <div class="card-item-alias">${esc(card.alias)}</div>
      <div class="card-item-sub">${esc(card.company)} &middot; ****${esc(card.lastFour)}</div>
    </div>
    <div class="card-item-actions">
      <button class="icon-btn edit-btn" title="수정" data-id="${card.id}">&#9998;</button>
      <button class="icon-btn delete-btn delete" title="삭제" data-id="${card.id}">&#215;</button>
    </div>`;

  item.querySelector('.edit-btn').addEventListener('click', () => openEditForm(card.id));
  item.querySelector('.delete-btn').addEventListener('click', () => handleDelete(card.id));
  return item;
}

// ── 카드 추가/수정 폼 ────────────────────────────────────────────────────────

function openAddForm() {
  formMode   = 'add';
  formEditId = null;
  document.getElementById('form-title-text').textContent = '카드 추가';
  document.getElementById('f-alias').value     = '';
  document.getElementById('f-company').value   = '';
  document.getElementById('f-last-four').value = '';
  showForm();
}

function openEditForm(id) {
  const card = allCards.find(c => c.id === id);
  if (!card) return;

  formMode   = 'edit';
  formEditId = id;
  document.getElementById('form-title-text').textContent = '카드 수정';
  document.getElementById('f-alias').value     = card.alias;
  document.getElementById('f-company').value   = card.company;
  document.getElementById('f-last-four').value = card.lastFour;
  showForm();
}

function showForm() {
  document.getElementById('card-form').hidden = false;
  document.getElementById('f-alias').focus();
}

function closeForm() {
  document.getElementById('card-form').hidden = true;
  formMode = 'add'; formEditId = null;
}

async function handleFormSave() {
  const alias    = document.getElementById('f-alias').value.trim();
  const company  = document.getElementById('f-company').value;
  const lastFour = document.getElementById('f-last-four').value.trim();

  if (!alias) {
    showStatus('카드 별칭을 입력해주세요.', 'error');
    document.getElementById('f-alias').focus();
    return;
  }
  if (!company) {
    showStatus('카드사를 선택해주세요.', 'error');
    document.getElementById('f-company').focus();
    return;
  }
  if (!/^\d{4}$/.test(lastFour)) {
    showStatus('카드 뒷번호 4자리를 정확히 입력해주세요.', 'error');
    document.getElementById('f-last-four').focus();
    return;
  }

  if (formMode === 'add') {
    // 중복 확인 (같은 카드사 + 뒷번호)
    const dup = allCards.find(c => c.company === company && c.lastFour === lastFour);
    if (dup) {
      showStatus(`이미 등록된 카드입니다: ${dup.alias}`, 'warning');
      return;
    }
    allCards.push({ id: generateId(), alias, company, lastFour });
  } else {
    const idx = allCards.findIndex(c => c.id === formEditId);
    if (idx !== -1) allCards[idx] = { ...allCards[idx], alias, company, lastFour };
  }

  await saveCards();
  closeForm();
  renderCardList();
  renderExtractTab();
  showStatus(formMode === 'add' ? '카드가 추가되었습니다.' : '카드가 수정되었습니다.', 'success');
}

async function handleDelete(id) {
  const card = allCards.find(c => c.id === id);
  if (!card) return;
  if (!window.confirm(`"${card.alias}" 카드를 삭제하시겠습니까?`)) return;

  allCards = allCards.filter(c => c.id !== id);
  // 삭제된 카드 ID는 선택 목록에서도 제거
  extractSettings.selectedCardIds = extractSettings.selectedCardIds.filter(sid => sid !== id);

  await saveCards();
  await saveExtractSettings();
  renderCardList();
  renderExtractTab();
  showStatus('카드가 삭제되었습니다.', 'info');
}

// ── 추출 실행 탭 렌더링 ──────────────────────────────────────────────────────

function renderExtractTab() {
  renderCardCheckboxes();
  refreshExtractButton();
  updateSelectAllLabel();
}

function renderCardCheckboxes() {
  const container = document.getElementById('card-checkboxes');

  if (allCards.length === 0) {
    container.innerHTML = `
      <div class="no-cards-notice">
        카드 관리 탭에서 먼저 카드를 등록해주세요.
      </div>`;
    return;
  }

  container.innerHTML = '';
  allCards.forEach(card => {
    const checked = extractSettings.selectedCardIds.includes(card.id);
    const color   = badgeColor(card.id);
    const label   = document.createElement('label');
    label.className = 'checkbox-label';
    label.innerHTML = `
      <input type="checkbox" value="${card.id}" ${checked ? 'checked' : ''}>
      <span class="checkbox-box"></span>
      <span class="cb-card-info">
        <span class="cb-alias">${esc(card.alias)}</span>
        <span class="cb-sub" style="color:${color}">${esc(card.company)} ****${esc(card.lastFour)}</span>
      </span>`;

    label.querySelector('input').addEventListener('change', e => {
      if (e.target.checked) {
        if (!extractSettings.selectedCardIds.includes(card.id)) {
          extractSettings.selectedCardIds.push(card.id);
        }
      } else {
        extractSettings.selectedCardIds = extractSettings.selectedCardIds.filter(id => id !== card.id);
      }
      saveExtractSettings();
      refreshExtractButton();
      updateSelectAllLabel();
    });

    container.appendChild(label);
  });
}

function toggleSelectAll() {
  const allIds    = allCards.map(c => c.id);
  const allChosen = allIds.every(id => extractSettings.selectedCardIds.includes(id));

  extractSettings.selectedCardIds = allChosen ? [] : [...allIds];
  saveExtractSettings();
  renderCardCheckboxes();
  refreshExtractButton();
  updateSelectAllLabel();
}

function updateSelectAllLabel() {
  const btn = document.getElementById('btn-select-all');
  const allIds = allCards.map(c => c.id);
  const allChosen = allIds.length > 0 && allIds.every(id => extractSettings.selectedCardIds.includes(id));
  btn.textContent = allChosen ? '전체 해제' : '전체 선택';
}

function refreshExtractButton() {
  const allCapture  = extractSettings.allCaptureMode;
  const hasCards    = allCards.length > 0;
  const hasSelected = extractSettings.selectedCardIds.length > 0;
  // 전체 캡처 모드: 카드 선택 없이도 실행 가능
  document.getElementById('btn-extract').disabled = !(allCapture || (hasCards && hasSelected));
}

// ── 기간 설정 UI ─────────────────────────────────────────────────────────────

function restorePeriodUI() {
  const mode = extractSettings.periodMode || 'this-month';
  const radio = document.querySelector(`input[name="period"][value="${mode}"]`);
  if (radio) radio.checked = true;

  document.getElementById('custom-date-range').hidden = (mode !== 'custom');
  document.getElementById('date-start').value = extractSettings.customStart || '';
  document.getElementById('date-end').value   = extractSettings.customEnd   || '';

  // 전체 캡처 토글 상태 복원
  const allCapture = extractSettings.allCaptureMode || false;
  document.getElementById('toggle-all-capture').checked = allCapture;
  _applyAllCaptureUI(allCapture);
}

function _applyAllCaptureUI(on) {
  // 카드 선택 영역을 흐리게 처리해 비활성 상태를 시각적으로 표시
  const section = document.querySelector('#tab-extract .ex-section');
  if (section) section.classList.toggle('card-section-dimmed', on);
}

/**
 * 선택된 기간 모드를 바탕으로 { start, end } (YYYY-MM-DD) 반환.
 * 기간 없음이면 null.
 */
function computeDateRange() {
  const mode = extractSettings.periodMode;
  const now  = new Date();
  const pad  = n => String(n).padStart(2, '0');
  const fmt  = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;

  switch (mode) {
    case 'all': return null;

    case 'this-month': {
      const s = new Date(now.getFullYear(), now.getMonth(), 1);
      const e = new Date(now.getFullYear(), now.getMonth()+1, 0);
      return { start: fmt(s), end: fmt(e) };
    }
    case 'last-month': {
      const s = new Date(now.getFullYear(), now.getMonth()-1, 1);
      const e = new Date(now.getFullYear(), now.getMonth(), 0);
      return { start: fmt(s), end: fmt(e) };
    }
    case 'this-week': {
      const day = now.getDay();
      const mon = new Date(now); mon.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
      const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
      return { start: fmt(mon), end: fmt(sun) };
    }
    case 'last-week': {
      const day = now.getDay();
      const thisMon = new Date(now); thisMon.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
      const lastMon = new Date(thisMon); lastMon.setDate(thisMon.getDate() - 7);
      const lastSun = new Date(lastMon); lastSun.setDate(lastMon.getDate() + 6);
      return { start: fmt(lastMon), end: fmt(lastSun) };
    }
    case 'custom': {
      const s = extractSettings.customStart;
      const e = extractSettings.customEnd;
      if (!s || !e) {
        showStatus('시작일과 종료일을 모두 입력해주세요.', 'error');
        return undefined; // undefined = 오류 상태
      }
      if (s > e) {
        showStatus('시작일이 종료일보다 늦을 수 없습니다.', 'error');
        return undefined;
      }
      return { start: s, end: e };
    }
    default: return null;
  }
}

// ── 추출 실행 ────────────────────────────────────────────────────────────────

async function handleExtract() {
  const allCapture = extractSettings.allCaptureMode || false;

  // 선택된 카드 객체 수집 (전체 캡처 모드에서는 카드 선택 불필요)
  const selectedCards = allCards.filter(c => extractSettings.selectedCardIds.includes(c.id));
  if (!allCapture && selectedCards.length === 0) {
    showStatus('추출할 카드를 선택하거나, 전체 캡처 모드를 켜주세요.', 'error');
    return;
  }

  // 날짜 범위 계산
  const dateRange = computeDateRange();
  if (dateRange === undefined) return; // 유효성 오류 (이미 showStatus 호출됨)

  // 현재 활성 탭에 메시지 전송
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    showStatus('활성 탭을 확인할 수 없습니다.', 'error');
    return;
  }

  setExtractLoading(true);
  showStatus('추출을 시작합니다...', 'progress');

  const msgPayload = {
    action: 'START_EXTRACTION',
    selectedCards,   // [{ id, alias, company, lastFour }]
    dateRange,       // { start, end } | null
    allCaptureMode: allCapture,
  };

  try {
    await chrome.tabs.sendMessage(tab.id, msgPayload);
  } catch (err) {
    const notInjected =
      err.message?.includes('Could not establish connection') ||
      err.message?.includes('Receiving end does not exist');

    if (notInjected) {
      // 콘텐츠 스크립트 미주입 → 직접 주입 후 재시도
      try {
        showStatus('스크립트 주입 중...', 'progress');
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: [
            'libs/html2canvas.min.js',
            'parsers/coupang.js',
            'parsers/naverpay.js',
            'parsers/index.js',
            'content.js',
          ],
        });
        await chrome.tabs.sendMessage(tab.id, msgPayload);
        return; // 성공 → 이후 결과는 STATUS_UPDATE 메시지로 수신
      } catch {
        // 주입도 실패 (지원하지 않는 페이지 등)
      }
      showStatus('페이지를 새로고침(F5) 후 다시 시도해주세요.', 'error');
    } else {
      showStatus(`오류: ${err.message}`, 'error');
    }
    setExtractLoading(false);
    return;
  }

  // 안전장치: 120초 후 버튼 자동 복구
  setTimeout(() => setExtractLoading(false), 120_000);
}

function setExtractLoading(on) {
  const btn   = document.getElementById('btn-extract');
  const label = btn.querySelector('.btn-label');
  const stop  = document.getElementById('btn-stop');

  btn.classList.toggle('loading', on);
  btn.disabled = on;
  label.textContent = on ? '추출 중...' : '증빙 추출 시작';

  stop.hidden   = !on;
  stop.disabled = false;
  stop.textContent = '■ 추출 중지';
}

// ── 스토리지 ─────────────────────────────────────────────────────────────────

async function saveCards() {
  await chrome.storage.local.set({ cards: allCards });
}

async function saveExtractSettings() {
  await chrome.storage.local.set({ extractSettings });
}

// ── 상태 표시줄 ──────────────────────────────────────────────────────────────

function showStatus(text, type = 'info') {
  const bar  = document.getElementById('status-bar');
  const span = document.getElementById('status-text');
  bar.className = `status-bar visible ${type}`;
  bar.hidden    = false;
  span.textContent = text;
}

// ── 유틸 ────────────────────────────────────────────────────────────────────

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function badgeColor(id) {
  let hash = 0;
  for (const ch of String(id)) hash = (hash * 31 + ch.charCodeAt(0)) & 0xffffffff;
  return BADGE_COLORS[Math.abs(hash) % BADGE_COLORS.length];
}

function badgeLetter(alias) {
  return (alias || '?').trim().charAt(0).toUpperCase();
}

/** XSS 방지용 HTML 이스케이프 */
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
