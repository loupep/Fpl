// The app's data access. In the Android app requests go straight to FPL from
// the phone; on a computer they go through the local server.

import { ServerBackend, NativeBackend } from './backends.js';

const backend = typeof window !== 'undefined' && window.FplNative ? new NativeBackend(window.FplNative) : new ServerBackend();

export const isNative = backend.native;
export const getSession = () => backend.getSession();
export const connect = (input) => backend.connect(input);
export const login = () => backend.login();
export const loginViaWebsite = () => backend.loginViaWebsite();
export const resumeLogin = () => backend.resumeLogin();
export const disconnect = () => backend.disconnect();
export const demoLogin = () => backend.demoLogin();
export const fpl = (path) => backend.fpl(path);
export const saveLineup = (entry, payload) => backend.saveLineup(entry, payload);
export const makeTransfers = (payload) => backend.makeTransfers(payload);
