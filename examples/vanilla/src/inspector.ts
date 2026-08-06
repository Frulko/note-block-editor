import { docToJSON, plainText, type Editor, type Op } from '@nbe/core';

function short(id: string): string {
  return id.slice(0, 8);
}

function summarize(op: Op): string {
  switch (op.type) {
    case 'insert_block':
      return `insert_block(${op.block.type} ${short(op.block.id)} @${op.index})`;
    case 'delete_block':
      return `delete_block(${short(op.id)})`;
    case 'move_block':
      return `move_block(${short(op.id)} → ${short(op.parentId)} after ${op.after ? short(op.after) : '∅'})`;
    case 'update_block':
      return `update_block(${short(op.id)}, ${JSON.stringify(op.patch)})`;
    case 'insert_text':
      return `insert_text(${short(op.id)} @${op.offset}, ${JSON.stringify(plainText(op.runs))})`;
    case 'delete_text':
      return `delete_text(${short(op.id)}, ${op.from}–${op.to})`;
    case 'format_text':
      return `format_text(${short(op.id)}, ${op.from}–${op.to}, ${op.add ? '+' : '−'}${op.mark.type})`;
  }
}

export function attachInspector(editor: Editor): () => void {
  const docPanel = document.getElementById('panel-doc')!;
  const opsPanel = document.getElementById('panel-ops')!;
  opsPanel.replaceChildren();

  let scheduled = false;
  const renderDoc = () => {
    scheduled = false;
    docPanel.textContent = JSON.stringify(docToJSON(editor.doc), null, 2);
  };
  renderDoc();

  return editor.on((change) => {
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(renderDoc);
    }
    const entry = document.createElement('div');
    entry.className = 'op-entry';
    const origin = document.createElement('span');
    origin.className = 'op-origin';
    origin.textContent = change.origin;
    entry.append(origin, change.ops.map(summarize).join('\n'));
    opsPanel.append(entry);
    while (opsPanel.children.length > 200) opsPanel.firstElementChild!.remove();
    opsPanel.scrollTop = opsPanel.scrollHeight;
  });
}
