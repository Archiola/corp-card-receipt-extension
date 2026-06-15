'use strict';

/**
 * ParserRegistry
 *
 * 쇼핑몰별 파서를 등록하고, 현재 호스트명에 맞는 파서를 반환한다.
 *
 * [새 쇼핑몰 추가 방법]
 *  1. parsers/{site}.js 작성 (coupang.js를 템플릿으로 사용)
 *  2. 아래 PARSERS 배열에 파서 객체 추가
 *  3. manifest.json → host_permissions, content_scripts.matches 에 URL 추가
 */
var ParserRegistry = (() => {

  const PARSERS = [
    CoupangParser,    // mc.coupang.com
    NaverPayParser,   // shopping.naver.com
    // GmarketParser,
    // ElevenstParser,
  ];

  /**
   * 현재 hostname에 맞는 파서를 반환한다.
   * @param {string} hostname  - window.location.hostname
   * @returns {object|null}
   */
  function getParser(hostname) {
    return PARSERS.find(p =>
      p.hostnames.some(h => hostname.includes(h))
    ) || null;
  }

  return { getParser };
})();
