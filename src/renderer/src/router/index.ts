import { createRouter, createWebHashHistory } from 'vue-router'

/**
 * 必须用 hash 模式：生产环境走 file:// 协议，history 模式刷新会 404（方案书 §4.3）。
 */
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/connections' },
    {
      path: '/connections',
      name: 'connections',
      component: () => import('../views/ConnectionsView.vue')
    },
    {
      path: '/targets',
      name: 'targets',
      component: () => import('../views/TargetsView.vue')
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('../views/SettingsView.vue')
    }
  ]
})
