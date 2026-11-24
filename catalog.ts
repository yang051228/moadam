export const stages: Record<string, string> = {
  open: "모집 중",
  full: "모집 완료",
  pending: "구매 확정 대기",
  ordered: "주문 완료",
  shipping: "배송 중",
  ready: "수령 가능",
  done: "수령 완료",
  failed: "모집 실패",
  stopped: "운영 중단",
};
export const catalog = [
  ["도톰한 3겹 데일리 화장지", "tissue", "생활용품", 18900, 30, 6, 5],
  ["올인원 세탁세제 캡슐", "detergent", "세탁·청소", 24000, 60, 6, 3],
  ["도톰한 대용량 물티슈", "wipes", "생활용품", 14400, 12, 6, 4],
  ["얼큰한 컵라면 12개입", "ramen", "식품", 12000, 12, 4, 2],
  ["달콤바삭 과자 모음", "snacks", "식품", 18000, 24, 6, 2],
  ["데일리 필기구 세트", "pens", "문구", 10000, 20, 5, 1],
] as const;
export const checks = [
  "택배 수령",
  "상품 수량 확인",
  "참여자별 분배",
  "수령 장소 준비",
  "수령 안내 확인",
];
export const responsibilities = [
  "모집이 완료되면 상품을 주문할게요.",
  "배송된 상품을 받고 수량을 확인할게요.",
  "신청 수량에 맞춰 소분할게요.",
  "안내한 일정과 장소에서 전달할게요.",
  "상품 문제와 일정 변경을 안내할게요.",
];
export const day = 86400000;
