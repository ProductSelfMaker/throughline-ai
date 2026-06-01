// src/domain/flow-prompt.ts
export function buildFlowPrompt(specMd: string): string {
  return [
    '아래 기획서를 바탕으로 제품의 핵심 유저 플로우를 mermaid flowchart로 그려라.',
    '규칙:',
    '1) 출력은 오직 mermaid 코드만. 설명 문장, 코드펜스(```), 그 외 텍스트는 절대 넣지 않는다.',
    '2) 첫 줄은 "flowchart TD" 로 시작한다.',
    '3) 노드 라벨은 한국어로 짧게. 화면/단계 전환을 화살표(-->)로 잇는다.',
    '4) 아직 정해지지 않은 부분은 무리해서 만들지 말고, 알려진 흐름만 그린다.',
    '',
    '기획서:',
    '"""',
    specMd,
    '"""',
  ].join('\n');
}
