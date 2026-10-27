import { useEffect } from 'react'
import { X } from 'lucide-react'
import { t } from '@shared/i18n'

interface Props {
  title: React.ReactNode
  onClose(): void
  children: React.ReactNode
  footer?: React.ReactNode
  wide?: boolean
}

export function Modal({ title, onClose, children, footer, wide }: Props): React.JSX.Element {
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <header>
          <h2>{title}</h2>
          <button className="icon" onClick={onClose} aria-label={t('close')}>
            <X size={16} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  )
}

interface ConfirmProps {
  title: string
  body?: React.ReactNode
  confirm: string
  danger?: boolean
  onConfirm(): void
  onClose(): void
}

export function Confirm({ title, body, confirm, danger, onConfirm, onClose }: ConfirmProps): React.JSX.Element {
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>{t('cancel')}</button>
          <button
            className={danger ? 'danger' : 'primary'}
            autoFocus
            onClick={() => {
              onConfirm()
              onClose()
            }}
          >
            {confirm}
          </button>
        </>
      }
    >
      {body}
    </Modal>
  )
}

interface PromptProps {
  title: string
  label: string
  initial: string
  confirm: string
  onSubmit(v: string): void
  onClose(): void
}

export function Prompt({ title, label, initial, confirm, onSubmit, onClose }: PromptProps): React.JSX.Element {
  const submit = (e: React.FormEvent<HTMLFormElement>): void => {
    e.preventDefault()
    const v = String(new FormData(e.currentTarget).get('v') ?? '').trim()
    if (!v) return
    onSubmit(v)
    onClose()
  }
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit} className="form">
        <label>
          {label}
          <input name="v" defaultValue={initial} autoFocus />
        </label>
        <div className="form-actions">
          <button type="button" onClick={onClose}>
            {t('cancel')}
          </button>
          <button type="submit" className="primary">
            {confirm}
          </button>
        </div>
      </form>
    </Modal>
  )
}
