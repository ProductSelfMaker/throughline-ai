// src/domain/decisions-prompt.ts
export function buildDecisionsPrompt(activityExcerpt: string): string {
  return [
    '아래 활동 기록에서 *주요 의사결정*을 뽑아 마크다운으로 정리하라.',
    '각 결정은 "## <결정 요약>" 제목 아래 **무엇**(정한 것), **왜**(이유), **대안**(있었다면 무엇을 기각했는지)을 한 줄씩 적는다.',
    '실제로 정해진 결정만 담는다. 사소한 단계·작업 로그·구현 디테일은 제외.',
    '',
    '활동:',
    '"""',
    activityExcerpt || '(없음)',
    '"""',
    '',
    '마크다운만 출력하라. 설명 문장이나 코드펜스(```) 없이.',
  ].join('\n');
}
