// src/domain/mockup-prompt.ts
// The mockup's CSS is the project's REAL stylesheet (embedded verbatim by the
// assembler). So the model must NOT write CSS — it reproduces each real screen's
// DOM using the actual class names, lays them out as artboards, and fills data
// from the product doc (inferring from the UI only where the doc is silent).
export function buildMockupPrompt(input: { doc: string; css: string; components: string }): string {
  const { doc, css, components } = input;
  return [
    'You produce the <body> content of a design mockup that reproduces this project\'s *actually implemented* screens pixel-for-pixel.',
    'Below are the app\'s real CSS (in full) and its UI component source. The CSS is included verbatim in the output, so you must NOT write any CSS.',
    '',
    'Core rules:',
    '1) Do not write CSS. No style attributes, no <style>. Use only the class names and DOM structure that exist in the real source.',
    '2) Each screen\'s markup must use the same elements, classes, and nesting the component source renders. Do not invent new classes.',
    '3) Reproduce the app shell (root container, regions, rail, floating elements, etc.) exactly as the component source builds it.',
    '',
    'Output format — emit ONLY the HTML fragment that goes inside <body>:',
    '- A single top-level <div class="mock-canvas">.',
    '- Inside it, one <div class="mock-art"> per screen/state:',
    '    <div class="mock-art"><div class="mock-label">Screen name</div><div class="mock-frame">…real screen DOM…</div></div>',
    '- Inside mock-frame, reproduce a whole screen starting from the real app root (e.g. <div class="tl" ...>).',
    '',
    'Screens/states to include — only those that ACTUALLY exist in the source, each as its own artboard:',
    '- Every major screen/view (everything reachable via routing/view switching).',
    '- Every interactive/interrupt/overlay state: modals & dialogs, expanded panels/chat, open dropdowns/menus, hover/focus, empty, loading, error, toasts, etc. (only those implemented in the source).',
    '- Never invent screens or features that are not in the source.',
    '',
    'Data: instead of real data, fill with believable placeholder data grounded in the product doc. Where the doc is silent, infer naturally from the UI (component source). Write the placeholder text in the SAME language the product doc / app uses — do not translate it.',
    '',
    '=== Real CSS (reference; auto-included in the output — do NOT rewrite it) ===',
    '```css',
    css || '/* (no stylesheet found — base class names on the component source) */',
    '```',
    '',
    '=== Real UI component source (the basis for DOM & class names) ===',
    '```',
    components || '(no component source found)',
    '```',
    '',
    '=== Product doc (the basis for data & copy) ===',
    '"""',
    doc,
    '"""',
    '',
    'Output only the HTML fragment starting with <div class="mock-canvas"> — no commentary, no code fences (```).',
  ].join('\n');
}
