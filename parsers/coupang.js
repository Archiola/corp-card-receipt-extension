'use strict';

/**
 * CoupangParser v3.0 — __NEXT_DATA__ 기반 + 다중 페이지 지원
 *
 * ── 설계 변경점 ────────────────────────────────────────────────────────────
 *  v2: DOM 요소를 item으로 사용, history 인터셉션으로 orderId 추출
 *  v3: window.__NEXT_DATA__ + 추가 페이지 fetch로 모든 주문을 순수 데이터 객체로 수집
 *      → DOM 의존성 제거, 화면 이동 없음, 페이지네이션 자동 처리
 *
 * content.js에서 item은 DOM Element가 아닌 아래 형태의 plain object:
 *   { orderId, orderedAt, title }
 *
 * getOrderItems()가 async이므로 content.js에서 await 필요 (이미 반영됨).
 * ────────────────────────────────────────────────────────────────────────────
 */
var CoupangParser = {
  name: '쿠팡',
  hostnames: ['mc.coupang.com'],

  isOrderListPage() {
    return window.location.pathname.startsWith('/ssr/desktop/order');
  },

  // ── 주문 목록 수집 (async, 다중 페이지) ─────────────────────────────────

  /**
   * 현재 페이지 및 후속 페이지에서 모든 주문 데이터를 수집한다.
   * item은 { orderId, orderedAt, title } 형태의 plain object.
   * @param {{ start: string, end: string } | null} dateRange
   * @returns {Promise<Array<{orderId:number, orderedAt:number, title:string}>>}
   */
  async getOrderItems(dateRange = null) {
    const seenIds  = new Set();
    const all      = [];

    // ── 1페이지: DOM의 <script id="__NEXT_DATA__"> 직접 파싱 ──────────────
    // 콘텐츠 스크립트(Isolated World)에서 window.__NEXT_DATA__ 는 접근 불가.
    // DOM 태그의 textContent 는 DOM 접근이므로 항상 읽을 수 있다.
    const nextData1 = this._readNextDataFromDOM();
    const buildId   = nextData1?.buildId || null;
    const page1     = this._extractFromNextData(nextData1);
    page1.forEach(o => { all.push(o); seenIds.add(String(o.orderId)); });
    console.log(`[WM][쿠팡] 1페이지: ${page1.length}건, buildId=${buildId}`);

    // ── 2페이지~: pageIndex=1, 2, 3, ... (URL 형식: ?pageIndex=N) ──────────
    for (let pageIndex = 1; pageIndex <= 19; pageIndex++) {
      // 중지 요청 확인 (창 열기 전 빠른 탈출)
      const { wmStopRequested } = await chrome.storage.local.get('wmStopRequested');
      if (wmStopRequested) {
        console.log(`[WM][쿠팡] 중지 요청 감지, 수집 종료 (${all.length}건 수집됨)`);
        break;
      }

      const more = await this._fetchPageOrders(buildId, pageIndex);
      if (!more.length) {
        console.log(`[WM][쿠팡] pageIndex=${pageIndex}: 빈 응답, 수집 종료`);
        break;
      }
      const fresh = more.filter(o => !seenIds.has(String(o.orderId)));
      if (!fresh.length) {
        console.log(`[WM][쿠팡] pageIndex=${pageIndex}: 중복, 수집 종료`);
        break;
      }
      // 날짜 기반 조기 종료: 이 페이지의 모든 신규 주문이 범위 시작일 이전이면 중단
      // (쿠팡은 최신순 정렬이므로, 이 이후 페이지에도 범위 안 주문이 없다)
      if (dateRange?.start) {
        const allBeforeRange = fresh.every(o => {
          const d = new Date(o.orderedAt);
          return !isNaN(d) && d.toISOString().slice(0, 10) < dateRange.start;
        });
        if (allBeforeRange) {
          console.log(`[WM][쿠팡] pageIndex=${pageIndex}: 모든 주문이 기간 이전 → 수집 종료`);
          break;
        }
      }
      fresh.forEach(o => { all.push(o); seenIds.add(String(o.orderId)); });
      console.log(`[WM][쿠팡] pageIndex=${pageIndex}: ${fresh.length}건 추가 (누계 ${all.length}건)`);
    }

    console.log(`[WM][쿠팡] 최종 수집: ${all.length}건`);
    return all;
  },

  /**
   * plain object item에서 주문 날짜(Date)를 반환한다.
   * orderedAt 은 Unix 타임스탬프(ms).
   * @param {{ orderedAt: number }} item
   * @returns {Date}
   */
  getOrderDate(item) {
    return new Date(item.orderedAt);
  },

  /**
   * plain object item에서 대표 상품명을 반환한다.
   * title은 __NEXT_DATA__의 order.title (첫 번째 상품 기준).
   * @param {{ title: string }} item
   * @returns {string}
   */
  getProductName(item) {
    return (item.title || '상품명미확인').trim();
  },

  /**
   * plain object item에서 주문 금액(문자열)을 반환한다.
   * @param {{ soldAmount?: number, totalAmount?: number }} item
   * @returns {string|null}  예: "31,500원" 또는 null
   */
  getOrderPrice(item) {
    const amount =
      item?.totalProductPrice ||
      item?.soldAmount        ||
      item?.totalAmount       ||
      item?.paymentAmount     ||
      item?.orderAmount       ||
      item?.price             ||
      item?.amount            ||
      item?.totalPrice        ||
      item?.finalPrice        ||
      item?.orderPrice;
    if (typeof amount === 'number' && amount > 0) {
      return `${amount.toLocaleString()}원`;
    }
    // 디버그: 첫 호출 시 가격 관련 필드 출력
    if (!CoupangParser._priceFieldLogged) {
      CoupangParser._priceFieldLogged = true;
      const priceKeys = Object.keys(item || {}).filter(k => /price|amount|cost|pay|total|sum/i.test(k));
      console.log('[WM][쿠팡] 가격 필드:',
        priceKeys.length
          ? priceKeys.map(k => `${k}=${JSON.stringify(item[k])}`).join(' | ')
          : '(없음) 전체 키: ' + Object.keys(item || {}).join(', ')
      );
    }
    return null;
  },

  /**
   * plain object item에서 영수증 URL을 반환한다 (동기).
   * history 인터셉션 없음 → 화면 이동 없음.
   * @param {{ orderId: number|string }} item
   * @returns {string|null}
   */
  getReceiptUrl(item) {
    const id = item.orderId;
    if (!id) return null;
    return `https://mc.coupang.com/ssr/desktop/receipt-specification?orderId=${encodeURIComponent(id)}`;
  },

  /**
   * __NEXT_DATA__ 주문 아이템에서 결제 카드사명을 반환한다.
   * 반환값이 null 이면 사전 필터링 없이 기존 흐름(영수증 캡처 후 매칭)으로 진행한다.
   * @param {object} item
   * @returns {string|null}
   */
  getCardCompany(item) {
    // 첫 호출 시 결제 관련 필드를 콘솔에 출력해 필드명 파악에 활용
    if (!CoupangParser._cardFieldLogged) {
      CoupangParser._cardFieldLogged = true;
      const payKeys = Object.keys(item || {}).filter(k => /pay|card|credit|method|settle/i.test(k));
      console.log('[WM][쿠팡] 결제 필드:',
        payKeys.length
          ? payKeys.map(k => `${k}=${JSON.stringify(item[k])}`).join(' | ')
          : '(없음) 전체 키: ' + Object.keys(item || {}).join(', ')
      );
    }

    return [
      item?.paymentMethod?.cardName,
      item?.paymentMethod?.issuerName,
      item?.paymentMethod?.type,
      item?.payInfo?.cardName,
      item?.payInfo?.issuerName,
      item?.paymentInfo?.cardName,
      item?.cardInfo?.issuerName,
      item?.creditCardName,
      item?.cardCompany,
      item?.cardName,
      item?.issuerName,
    ].find(x => x && typeof x === 'string') || null;
  },

  // ── 영수증 페이지 처리 ─────────────────────────────────────────────────

  /**
   * 영수증 Document에서 카드 뒷번호 4자리 중 일치하는 값을 반환한다.
   * @param {Document} doc
   * @param {string[]} cardLastFours
   * @returns {string|null}
   */
  findMatchingCard(doc, cardLastFours) {
    const text = doc.body?.innerText || doc.body?.textContent || '';
    for (const four of cardLastFours) {
      const matched =
        new RegExp(`(?:카드번호|결제카드|신용카드|체크카드)[^\\n]{0,60}${four}`).test(text) ||
        new RegExp(`[*\\d]{4}[\\-\\s][*\\d]{4}[\\-\\s][*\\d]{4}[\\-\\s]${four}(?:\\D|$)`).test(text) ||
        text.includes(four);
      if (matched) return four;
    }
    return null;
  },

  /**
   * 영수증 Document에서 캡처할 영역 요소를 반환한다.
   * @param {Document} doc
   * @returns {Element}
   */
  getReceiptElement(doc) {
    const sels = [
      '.receipt-specification', '.receipt-spec', '[class*="receiptSpec"]',
      '[class*="ReceiptSpec"]', '#receiptArea', '[class*="receipt"]',
      '[class*="Receipt"]', '.order-receipt', 'main', 'article',
      '#content', '.content',
    ];
    for (const sel of sels) {
      const el = doc.querySelector(sel);
      if (el) return el;
    }
    return doc.body;
  },

  // ── private helpers ────────────────────────────────────────────────────

  /**
   * DOM의 <script id="__NEXT_DATA__"> 태그를 파싱하여 반환한다.
   * Isolated World에서도 DOM 접근은 허용된다.
   * @returns {object|null}
   */
  _readNextDataFromDOM() {
    try {
      const el = document.getElementById('__NEXT_DATA__');
      if (!el?.textContent) return null;
      return JSON.parse(el.textContent);
    } catch (err) {
      console.warn('[WM][쿠팡] __NEXT_DATA__ 파싱 실패:', err);
      return null;
    }
  },

  /**
   * __NEXT_DATA__ 객체에서 orderList를 추출한다.
   * @param {object|null} nextData
   * @returns {Array}
   */
  _extractFromNextData(nextData) {
    try {
      return nextData?.props?.pageProps?.domains?.desktopOrder?.orderList || [];
    } catch {
      return [];
    }
  },

  /**
   * 백그라운드 탭을 열어 pageIndex=N 페이지의 주문 목록을 가져온다.
   *
   * SSR HTML fetch 는 항상 1페이지 데이터를 반환하므로 사용하지 않는다.
   * 대신 실제 탭을 열어 Next.js 라우터가 데이터를 교체한 뒤
   * MAIN world 에서 window.__NEXT_DATA__ 를 읽는다.
   *
   * @param {string|null} _buildId  미사용 (서명 유지용)
   * @param {number}      pageIndex 1 이상
   * @returns {Promise<Array>}
   */
  async _fetchPageOrders(_buildId, pageIndex) {
    const url = `https://mc.coupang.com/ssr/desktop/order/list?pageIndex=${pageIndex}`;
    console.log(`[WM][쿠팡] pageIndex=${pageIndex} 탭 로딩: ${url}`);

    try {
      const resp = await Promise.race([
        chrome.runtime.sendMessage({ action: 'FETCH_ORDER_PAGE', url }),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error(`pageIndex=${pageIndex} 타임아웃`)), 30000)
        ),
      ]);

      if (!resp?.ok) {
        console.warn(`[WM][쿠팡] pageIndex=${pageIndex} 탭 실패:`, resp?.error);
        return [];
      }

      const list = this._extractFromNextData(resp.nextData);
      console.log(`[WM][쿠팡] pageIndex=${pageIndex} 탭 성공: ${list.length}건`);
      return list;
    } catch (err) {
      console.warn(`[WM][쿠팡] pageIndex=${pageIndex} 예외:`, err);
      return [];
    }
  },
};
