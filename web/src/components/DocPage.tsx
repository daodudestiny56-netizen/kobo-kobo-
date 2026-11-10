import type { ReactNode } from 'react';

export interface DocSection {
  id: string;
  title: string;
  body: ReactNode;
}

// Legal and policy pages are documents, not product pages: a title, a status line, a contents list and numbered sections.
export function DocPage({ title, updated, notice, sections }: { title: string; updated: string; notice: string; sections: DocSection[] }) {
  return (
    <div className="wide" style={{ paddingTop: 'var(--s6)', paddingBottom: 'var(--s8)' }}>
      <h1 className="display">{title}</h1>
      <p className="muted mt3">Last updated {updated}</p>
      <p className="notice notice-attn mt4" style={{ maxWidth: '68ch' }}><span className="small">{notice}</span></p>

      <div className="doc mt6">
        <nav className="doc-toc" aria-label="Contents">
          <p className="eyebrow">Contents</p>
          <ol className="mt2">
            {sections.map((s, i) => (
              <li key={s.id}><a href={`#${s.id}`}>{i + 1}. {s.title}</a></li>
            ))}
          </ol>
        </nav>
        <div className="doc-body">
          {sections.map((s, i) => (
            <section key={s.id} id={s.id} aria-labelledby={`${s.id}-h`}>
              <h2 id={`${s.id}-h`}>{i + 1}. {s.title}</h2>
              {s.body}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
