'use strict';

/**
 * NaverPayParser v3.0 — 실제 DOM 구조 기반
 *
 * 대상 사이트 : https://shopping.naver.com/my/order
 *
 * 주문 아이템 : div[class*="OrderProduct_item_inner"]
 * 날짜        : div[class*="OrderProductItem_date"] → "6.12. 07:45 주문"
 * 상품명      : data-shp-contents-dtl 또는 [class*="OrderProductItem_name"]
 * 영수증 URL  : a[href*="orders.pay.naver.com/order/status/{orderId}"]
 *               → https://order.pay.naver.com/o/receipt/hist/{orderId}
 */
var NaverPayParser = {
  name: '네이버쇼핑',
  hostnames: ['shopping.naver.com'],

  isOrderListPage() {
    return window.location.pathname.startsWith('/my/order');
  },

  // ── 목록 페이지 DOM 파싱 ────────────────────────────────────────────

  async getOrderItems() {
    const MAX_MS  = 15000;
    const POLL_MS = 300;
    const started = Date.now();

    while (Date.now() - started < MAX_MS) {
      const items = this._findOrderItems();
      if (items.length > 0) {
        console.log(`[WM][네이버] ${items.length}건 탐지 (${Date.now() - started}ms 대기)`);
        return items;
      }
      await new Promise(r => setTimeout(r, POLL_MS));
    }

    console.warn('[WM][네이버] 주문 아이템 탐지 실패 (15초 초과)');
    console.warn('  body > #__next 구조:', document.querySelector('#__next')?.innerHTML?.substring(0, 200));
    return [];
  },

  _findOrderItems(doc = document) {
    // ── 전략 0: 실제 확인된 CSS module 클래스 프리픽스 ────────────────
    // 실제 클래스: OrderProduct_item_inner__eUmCN
    const byItemInner = doc.querySelectorAll('[class*="OrderProduct_item_inner"]');
    if (byItemInner.length) {
      console.log(`[WM][네이버] OrderProduct_item_inner: ${byItemInner.length}건`);
      return Array.from(byItemInner);
    }

    // ── 전략 1: 상품 영역 fallback ─────────────────────────────────────
    const byProductArea = doc.querySelectorAll('[class*="OrderProductItem_product_area"]');
    if (byProductArea.length) return Array.from(byProductArea);

    // ── 전략 2: 날짜+금액 포함 div (날짜 형식 무관) ────────────────────
    // 네이버 날짜 형식: "6.12. 07:45 주문" (M.DD. HH:MM 주문)
    const dateRe   = /\d{1,2}\.\d{1,2}\.\s*\d{2}:\d{2}|\d{4}[.\-년]\s*\d{1,2}[.\-월]\s*\d{1,2}|오늘|어제|\d+일\s*전/;
    const amountRe = /[\d,]+\s*원/;
    const orderContent = doc.querySelector('[class*="type_order"]') ||
                         doc.querySelector('[class*="MyDetailPageLayout_content"]');

    if (orderContent) {
      const candidates = Array.from(orderContent.querySelectorAll('div')).filter(el => {
        const text = el.textContent || '';
        return dateRe.test(text) && amountRe.test(text) && text.length > 80 && text.length < 3000;
      });
      const leaves = candidates.filter(el => !candidates.some(p => p !== el && p.contains(el)));
      if (leaves.length && leaves.length < 100) return leaves;
    }

    return [];
  },

  getOrderDate(item) {
    // 1) [class*="OrderProductItem_date"] → "6.12. 07:45 주문"
    const dateEl = item.querySelector('[class*="OrderProductItem_date"]');
    if (dateEl) {
      const text = dateEl.textContent.trim();
      // "6.12. 07:45 주문" 형식
      const mShort = text.match(/^(\d{1,2})\.(\d{1,2})\./);
      if (mShort) {
        const now   = new Date();
        const month = parseInt(mShort[1]);
        const day   = parseInt(mShort[2]);
        // 현재 월보다 미래 월이면 작년으로 간주
        let year = now.getFullYear();
        if (month > now.getMonth() + 1) year--;
        return new Date(year, month - 1, day);
      }
    }

    // 2) <time datetime="...">
    const timeEl = item.querySelector('time[datetime]');
    if (timeEl) { const d = new Date(timeEl.getAttribute('datetime')); if (!isNaN(d)) return d; }

    // 3) textContent 절대 날짜 패턴
    const d = _parseNaverDate(item.textContent);
    if (d) return d;

    // 4) 상대 날짜
    const text  = item.textContent || '';
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (/오늘/.test(text)) return new Date(today);
    if (/어제/.test(text)) { const d2 = new Date(today); d2.setDate(d2.getDate() - 1); return d2; }
    const daysAgo = text.match(/(\d+)일\s*전/);
    if (daysAgo) { const d3 = new Date(today); d3.setDate(d3.getDate() - parseInt(daysAgo[1])); return d3; }
    const weeksAgo = text.match(/(\d+)주일?\s*전/);
    if (weeksAgo) { const d4 = new Date(today); d4.setDate(d4.getDate() - parseInt(weeksAgo[1]) * 7); return d4; }
    const monthsAgo = text.match(/(\d+)개월\s*전/);
    if (monthsAgo) { const d5 = new Date(today); d5.setMonth(d5.getMonth() - parseInt(monthsAgo[1])); return d5; }

    return null;
  },

  getProductName(item) {
    // 1) data-shp-contents-dtl 속성에서 상품명 추출 (가장 정확)
    const shpEl = item.querySelector('[data-shp-contents-dtl]');
    if (shpEl) {
      try {
        const dtl = JSON.parse(shpEl.getAttribute('data-shp-contents-dtl') || '[]');
        const namePair = dtl.find(d => d.key === 'chnl_prod_nm');
        if (namePair?.value) return String(namePair.value).substring(0, 60);
      } catch (_) {}
    }

    // 2) [class*="OrderProductItem_name"]
    const nameEl = item.querySelector('[class*="OrderProductItem_name"]');
    if (nameEl) return nameEl.textContent.trim().substring(0, 60);

    // 3) img alt
    const img = item.querySelector('img[alt]');
    if (img?.alt) return img.alt.substring(0, 60);

    // 4) 가장 긴 텍스트 노드
    const spans = Array.from(item.querySelectorAll('span, p, div'))
      .filter(e => e.children.length === 0 && (e.textContent?.trim()?.length || 0) > 4);
    spans.sort((a, b) => b.textContent.length - a.textContent.length);
    if (spans[0]) return spans[0].textContent.trim().split('\n')[0].trim().substring(0, 60);

    return '상품명미확인';
  },

  /**
   * DOM item(OrderProduct_item_inner)에서 상품 가격을 추출한다.
   * @param {Element} item
   * @returns {string|null}
   */
  getOrderPrice(item) {
    // [class*="OrderProductItem_price"]에서 "31,500원" 형태 추출
    const priceEl = item.querySelector('[class*="OrderProductItem_price"]');
    if (priceEl) {
      const text = priceEl.textContent.trim();
      // 숫자+쉼표+원 패턴
      const m = text.match(/[\d,]+원/);
      if (m) return m[0];
    }
    return null;
  },

  getReceiptUrl(item) {
    // 1) orders.pay.naver.com/order/status/{orderId} → order.pay.naver.com/o/receipt/hist/{orderId}
    const detailLink = item.querySelector('a[href*="orders.pay.naver.com/order/status/"]');
    if (detailLink) {
      const m = detailLink.href.match(/order\/status\/(\d+)/);
      if (m) return `https://order.pay.naver.com/o/receipt/hist/${m[1]}`;
    }

    // 2) order.pay.naver.com 영수증 링크 직접 탐색
    for (const a of Array.from(item.querySelectorAll('a[href]'))) {
      const full = a.href || '';
      if (full.includes('order.pay.naver.com') &&
          (full.includes('/receipt/') || full.includes('/o/receipt'))) {
        return full;
      }
    }

    // 3) "주문상세" 링크
    const detailLink2 = Array.from(item.querySelectorAll('a[href]')).find(a =>
      /주문상세|상세보기/.test(a.textContent) || a.href.includes('/my/order/')
    );
    if (detailLink2) return detailLink2.href || null;

    return null;
  },

  // ── 영수증 Document 처리 (order.pay.naver.com 페이지) ────────────────

  findMatchingCard(doc, cardLastFours) {
    const text = doc.body?.innerText || doc.body?.textContent || '';
    for (const four of cardLastFours) {
      const hit =
        new RegExp(`(?:카드번호|결제수단|신용카드|체크카드|카드)[^\\n]{0,40}${four}`).test(text) ||
        new RegExp(`[*\\d]{4}[\\-\\s][*\\d]{4}[\\-\\s][*\\d]{4}[\\-\\s]${four}(?:\\D|$)`).test(text) ||
        text.includes(four);
      if (hit) return four;
    }
    return null;
  },

  getReceiptElement(doc) {
    const sels = [
      '[class*="Receipt"]', '[class*="receipt"]',
      '.pay_receipt', '#receipt',
      '[class*="PaymentInfo"]', '[class*="paymentInfo"]',
      'main', 'article', '#content', '.content',
    ];
    for (const sel of sels) {
      const el = doc.querySelector(sel);
      if (el) return el;
    }
    return doc.body;
  },
};

function _parseNaverDate(str) {
  if (!str) return null;
  str = str.trim();
  let m = str.match(/(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = str.match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  return null;
}
