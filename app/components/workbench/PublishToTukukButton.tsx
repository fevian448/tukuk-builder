import { useMemo, useState } from 'react';
import { useStore } from '@nanostores/react';
import { toast } from 'react-toastify';
import { chatId, description } from '~/lib/persistence/useChatHistory';
import { buildSingleFileHtml, publishProject, PublishError, type PublishHandleInput } from '~/lib/tukuk/publish';

type Status = 'idle' | 'busy' | 'done';

/*
 * Simpan pemilikan terbitan (slug + editKey) per-cabang supaya "Publish" seterusnya
 * MENGEMASKINI pautan /a/<slug> yang sama (bukan hasilkan slug baru setiap kali).
 * localStorage dipilih kerana mudah & cukup; kunci = chatId semasa.
 */
function handleKey(id: string | undefined): string | null {
  return id ? `tukuk-publish:${id}` : null;
}
function readHandle(id: string | undefined): PublishHandleInput | undefined {
  const key = handleKey(id);
  if (!key) return undefined;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw);
    return parsed && parsed.slug && parsed.editKey ? (parsed as PublishHandleInput) : undefined;
  } catch {
    return undefined;
  }
}
function writeHandle(id: string | undefined, handle: PublishHandleInput) {
  const key = handleKey(id);
  if (key) {
    try {
      localStorage.setItem(key, JSON.stringify(handle));
    } catch {
      /* penuh/privat mode — abaikan, publish tetap jalan (slug baru) */
    }
  }
}

export const PublishToTukukButton = () => {
  const id = useStore(chatId);
  const title = useStore(description);
  const [status, setStatus] = useState<Status>('idle');

  const label = useMemo(() => {
    if (status === 'busy') return 'Terbit…';
    if (status === 'done') return 'Diterbit';
    return readHandle(id) ? 'Kemas kini ke Store' : 'Publish ke Store';
  }, [status, id]);

  const onClick = async () => {
    if (status === 'busy') return;
    setStatus('busy');
    const toastId = toast.info('Membina & menerbitkan projek ke Tukuk Store…', { autoClose: false, closeOnClick: false });

    try {
      const { html, looksLikeGame } = await buildSingleFileHtml();
      const name = (title && title.trim()) || 'Tukuk App';
      const kind: 'game' | 'app' = looksLikeGame ? 'game' : 'app';
      const existing = readHandle(id);
      const result = await publishProject({ html, name, kind, handle: existing });
      const editKey = result.editKey ?? existing?.editKey;
      if (result.slug && editKey) writeHandle(id, { slug: result.slug, editKey });
      setStatus('done');
      toast.dismiss(toastId);
      toast.success(
        <span>
          Diterbit!{' '}
          <a href={result.url} target="_blank" rel="noopener noreferrer" className="underline font-semibold">
            {result.url}
          </a>
        </span>,
        { autoClose: 8000 },
      );
    } catch (error) {
      setStatus('idle');
      toast.dismiss(toastId);
      const message = error instanceof PublishError ? error.message : 'Penerbitan gagal. Cuba lagi.';
      toast.error(message, { autoClose: 10000 });
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={status === 'busy'}
      title="Pakejkan projek sebagai satu fail HTML dan terbitkan ke Tukuk Store"
      className="flex items-center gap-1 px-2.5 h-8 rounded-full text-sm font-medium transition-colors bg-bolt-elements-item-backgroundAccent text-bolt-elements-item-contentAccent hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed"
    >
      <div className={status === 'busy' ? 'i-svg-spinners:90-ring-with-bg h-4 w-4' : 'i-ph:upload-simple h-4 w-4'} />
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
};
