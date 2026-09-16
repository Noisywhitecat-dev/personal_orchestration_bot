import { useEffect, useRef, useState } from 'react';
import type { Task } from '../../shared/contracts.js';

export function DeleteTaskDialog({
  task,
  onDelete,
  onClose,
}: {
  task: Task;
  onDelete: (id: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const element = dialog.current;
    const trigger = document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected)
        trigger.focus({ preventScroll: true });
      else document.querySelector<HTMLButtonElement>('.new-task')?.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="delete-dialog"
      aria-labelledby="delete-title"
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const buttons = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
        ];
        if (!buttons.length) {
          event.preventDefault();
          return;
        }
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.shiftKey
          ? index <= 0
            ? buttons.length - 1
            : index - 1
          : (index + 1) % buttons.length;
        event.preventDefault();
        buttons[next]?.focus();
      }}
      onCancel={(e) => {
        if (busy) e.preventDefault();
        else onClose();
      }}
    >
      <h2 id="delete-title">대화를 삭제할까요?</h2>
      <p className="delete-task-title">{task.plan?.title ?? task.request}</p>
      <p>이 작업의 대화, 계획, 실행 기록, 로컬 토큰 집계를 삭제합니다. 되돌릴 수 없습니다.</p>
      <p>프로젝트 파일과 계정의 실제 사용량은 바뀌지 않습니다.</p>
      {failed && (
        <p role="alert">삭제하지 못했습니다. 작업이 끝났는지 확인한 뒤 다시 시도하세요.</p>
      )}
      <div className="button-row">
        <button className="secondary" autoFocus disabled={busy} onClick={onClose}>
          취소
        </button>
        <button
          className="danger"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setFailed(false);
            if (await onDelete(task.id)) onClose();
            else {
              setBusy(false);
              setFailed(true);
            }
          }}
        >
          {busy ? '삭제 중…' : '대화 영구 삭제'}
        </button>
      </div>
    </dialog>
  );
}
