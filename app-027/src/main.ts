import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import { loadVersions } from './logic/versions'
import './styles/global.css'

loadVersions()

createApp(App).use(router).mount('#app')
