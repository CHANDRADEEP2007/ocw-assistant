import React from 'react';

export function InlineCard(props: { title: string; children: React.ReactNode; tone?: 'default' | 'success' }) {
  return (
    <div className={`inline-card ${props.tone === 'success' ? 'success' : ''}`}>
      <div className="inline-card-title">{props.title}</div>
      <div>{props.children}</div>
    </div>
  );
}
