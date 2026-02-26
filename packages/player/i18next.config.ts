import { defineConfig } from "i18next-cli";

export default defineConfig({
	locales: ["zh-CN", "zh-TW", "en-US", "ja-JP", "vi-VN"],
	extract: {
		input: ["src/**/*.{ts,tsx}"],
		ignore: ["**/extension-env.d.ts"], // 不知为何 i18next-cli 扫描 extension-env.d.ts 的时候会报错
		output: "locales/{{language}}/{{namespace}}.json",
		disablePlurals: true,
		defaultNS: "translation",
		primaryLanguage: "en-US",
	},
});
