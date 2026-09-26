export const state = { user: null, settings: null, rerender: () => {} };
export const isOwner = () => !!state.user && state.user.role === 'owner';
