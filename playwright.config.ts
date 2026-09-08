import { defineConfig } from '@playwright/test';
const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:8787';
export default defineConfig({testDir:'./tests/e2e',timeout:30_000,use:{baseURL,viewport:{width:1440,height:900},trace:'retain-on-failure',launchOptions:process.env.AGENT_BROWSER_EXECUTABLE_PATH?{executablePath:process.env.AGENT_BROWSER_EXECUTABLE_PATH}:undefined},webServer:{command:process.platform==='win32'?'npm.cmd run dev':'npm run dev',url:`${baseURL}/api/health`,reuseExistingServer:true,timeout:60_000,env:{PORT:new URL(baseURL).port||'8787'}}});
