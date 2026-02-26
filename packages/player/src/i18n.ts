import resources from "virtual:i18next-loader";
import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import ICU from "i18next-icu";
import { initReactI18next } from "react-i18next";

type ResourcesType = typeof resources;

const supportedLanguages = Object.keys(resources) as (keyof ResourcesType)[];

declare module "i18next" {
	// Extend CustomTypeOptions
	interface CustomTypeOptions {
		defaultNS: "translation";
		resources: ResourcesType["zh-CN"];
	}
}

i18n
	.use(initReactI18next)
	.use(ICU)
	.use(LanguageDetector)
	.init({
		resources,
		debug: import.meta.env.DEV,
		fallbackLng: "en-US",
		supportedLngs: supportedLanguages,
		nonExplicitSupportedLngs: true,
		defaultNS: "translation",
		interpolation: {
			escapeValue: false,
		},
	});

export default i18n;
