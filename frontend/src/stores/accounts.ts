import { create } from 'zustand';
import type { DtAccountListItem } from '../types';
import * as api from '../services/endpoints';

interface AccountListState {
  accounts: DtAccountListItem[];
  total: number;
  loading: boolean;
  fetchAccounts: (params?: { page?: number; pageSize?: number; status?: string; keyword?: string }) => Promise<void>;
  toggleMonitor: (id: number, current: boolean) => Promise<void>;
}

export const useAccountListStore = create<AccountListState>((set, get) => ({
  accounts: [],
  total: 0,
  loading: false,

  fetchAccounts: async (params) => {
    set({ loading: true });
    try {
      const data = await api.getAccounts(params);
      set({ accounts: data.list, total: data.total });
    } finally {
      set({ loading: false });
    }
  },

  toggleMonitor: async (id, current) => {
    if (current) {
      await api.stopMonitor(id);
      get().fetchAccounts();
    } else {
      await api.startMonitor(id);
      get().fetchAccounts();
    }
  },
}));
