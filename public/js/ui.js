// Small DOM helpers shared by the views.

import { POSITIONS } from './rules.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const money = (tenths) => `£${(Number(tenths ?? 0) / 10).toFixed(1)}m`;
export const posShort = (type) => POSITIONS[type]?.short ?? '';
export const num = (n) => Number(n ?? 0).toLocaleString('en-GB');

export function deadlineText(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function countdown(iso, now = Date.now()) {
  const ms = Date.parse(iso) - now;
  if (!(ms > 0)) return 'passed';
  const m = Math.floor(ms / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d > 0) return `${d}d ${h}h ${mm}m`;
  if (h > 0) return `${h}h ${mm}m`;
  return `${mm}m`;
}

// Real club colours where we know them; anything else gets a stable colour
// derived from its name.
const CLUB_COLOURS = {
  ARS: ['#e30613', '#ffffff'], AVL: ['#7a003c', '#94bee5'], BOU: ['#da291c', '#111111'], BRE: ['#e30613', '#ffffff'],
  BHA: ['#0057b8', '#ffffff'], BUR: ['#6c1d45', '#99d6ea'], CHE: ['#034694', '#ffffff'], CRY: ['#1b458f', '#c4122e'],
  EVE: ['#003399', '#ffffff'], FUL: ['#f5f5f5', '#111111'], IPS: ['#3a64a3', '#ffffff'], LEE: ['#f5f5f5', '#1d428a'],
  LEI: ['#003090', '#fdbe11'], LIV: ['#c8102e', '#f6eb61'], LUT: ['#f78f1e', '#002d62'], MCI: ['#6cabdd', '#ffffff'],
  MUN: ['#da291c', '#111111'], NEW: ['#241f20', '#f5f5f5'], NFO: ['#dd0000', '#ffffff'], NOR: ['#fff200', '#00a650'],
  SHU: ['#ee2737', '#111111'], SOU: ['#d71920', '#ffffff'], SUN: ['#eb172b', '#ffffff'], TOT: ['#f5f5f5', '#132257'],
  WAT: ['#fbee23', '#ed2127'], WHU: ['#7a263a', '#1bb1e7'], WOL: ['#fdb913', '#231f20'],
};

export function clubColours(team) {
  if (!team) return ['#667', '#ccd'];
  if (CLUB_COLOURS[team.short_name]) return CLUB_COLOURS[team.short_name];
  let h = 0;
  for (const c of team.name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const hue = h % 360;
  return [`hsl(${hue} 62% 46%)`, `hsl(${(hue + 160) % 360} 70% 88%)`];
}

export function shirt(team, isKeeper = false) {
  const [body, trim] = isKeeper ? ['#e9c845', '#1d1d1d'] : clubColours(team);
  return `<svg class="shirt" viewBox="0 0 40 40" aria-hidden="true">
    <path d="M13 4 L4 9.5 L7.5 17.5 L11.5 15.5 L11.5 36 L28.5 36 L28.5 15.5 L32.5 17.5 L36 9.5 L27 4 Q24 8 20 8 Q16 8 13 4 Z" fill="${body}" stroke="rgba(0,0,0,.35)" stroke-width="1"/>
    <path d="M13 4 L4 9.5 L7.5 17.5 L11.5 15.5 Z M27 4 L36 9.5 L32.5 17.5 L28.5 15.5 Z" fill="${trim}" opacity=".9"/>
    <path d="M16.5 5.5 Q20 9.5 23.5 5.5" fill="none" stroke="${trim}" stroke-width="1.6"/>
  </svg>`;
}

export function statusFlag(el) {
  if (!el || el.status === 'a') return '';
  const chance = el.chance_of_playing_next_round;
  const kind = el.status === 'd' && chance !== 0 ? 'warn' : 'bad';
  const label = el.status === 'd' && chance != null ? `${chance}%` : '!';
  return `<span class="flag flag-${kind}" title="${esc(el.news || 'Unavailable')}">${esc(label)}</span>`;
}

export function fixtureText(list, teams) {
  if (!list?.length) return 'Blank';
  return list.map((f) => `${teams.get(f.opp)?.short_name ?? '?'} (${f.home ? 'H' : 'A'})`).join(', ');
}

export function fdrClass(list) {
  if (!list?.length) return 'fdr-blank';
  return `fdr-${Math.max(...list.map((f) => f.difficulty))}`;
}

// ------------------------------------------------------------------ toasts

export function toast(message, kind = 'info', ms = 4200) {
  const root = document.getElementById('toast-root');
  const node = document.createElement('div');
  node.className = `toast toast-${kind}`;
  node.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  node.textContent = message;
  root.append(node);
  requestAnimationFrame(() => node.classList.add('show'));
  setTimeout(() => {
    node.classList.remove('show');
    setTimeout(() => node.remove(), 300);
  }, ms);
}

// ------------------------------------------------------------------ modals

let openModalState = null;

export function closeModal() {
  if (!openModalState) return;
  const { node, onKey, returnFocus } = openModalState;
  openModalState = null;
  document.removeEventListener('keydown', onKey);
  node.remove();
  returnFocus?.focus?.();
}

// actions: { [name]: (event) => void|false } called for clicks on [data-action=name]
export function openModal({ title, body, footer = '', actions = {}, wide = false, className = '' }) {
  closeModal();
  const node = document.createElement('div');
  node.className = 'modal-backdrop';
  node.innerHTML = `<div class="modal ${wide ? 'modal-wide' : ''} ${className}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <header class="modal-head"><h2>${esc(title)}</h2><button class="icon-btn" data-action="close" aria-label="Close">✕</button></header>
      <div class="modal-body">${body}</div>
      ${footer ? `<footer class="modal-foot">${footer}</footer>` : ''}
    </div>`;
  const onKey = (e) => { if (e.key === 'Escape') closeModal(); };
  node.addEventListener('click', (e) => {
    if (e.target === node) return closeModal();
    const btn = e.target.closest('[data-action]');
    if (!btn || btn.disabled) return;
    const name = btn.dataset.action;
    if (name === 'close') return closeModal();
    actions[name]?.(e, btn);
  });
  document.addEventListener('keydown', onKey);
  document.getElementById('modal-root').append(node);
  openModalState = { node, onKey, returnFocus: document.activeElement };
  (node.querySelector('[data-autofocus]') ?? node.querySelector('.modal-foot .btn-primary') ?? node.querySelector('[data-action="close"]'))?.focus();
  return node;
}

export function confirmModal({ title, body, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } closeModal(); };
    const node = openModal({
      title,
      body,
      footer: `<button class="btn" data-action="cancel">Cancel</button>
               <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-action="ok">${esc(confirmLabel)}</button>`,
      actions: { cancel: () => finish(false), ok: () => finish(true) },
    });
    const observer = new MutationObserver(() => {
      if (!node.isConnected) { observer.disconnect(); if (!done) { done = true; resolve(false); } }
    });
    observer.observe(document.getElementById('modal-root'), { childList: true });
  });
}

export function busy(button, on) {
  if (!button) return;
  button.disabled = on;
  button.classList.toggle('is-busy', on);
}
