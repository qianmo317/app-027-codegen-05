import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import { loadState } from './logic/store'
import { loadVersionStore } from './logic/versions'
import './styles/global.css'

loadState()
loadVersionStore()

createApp(App).use(router).mount('#app')