const i18next = require('i18next');
const Backend = require('i18next-fs-backend');
const path = require('path');
const fs = require('fs');

// Track initialization state
let isInitialized = false;
let initPromise = null;

// Initialize i18next with better error handling
const initializeI18n = async () => {
  // If already initialized, return the existing instance
  if (isInitialized) return i18next;
  
  // If initialization is in progress, return the promise
  if (initPromise) return initPromise;

  // Create a new promise for initialization
  initPromise = (async () => {
    try {
      console.log('🌐 Initializing i18next...');
      
      // Check if locales directory exists
      const localesPath = path.join(__dirname, '../locales');
      console.log('Locales path:', localesPath);
      
      if (!fs.existsSync(localesPath)) {
        throw new Error(`❌ Locales directory does not exist: ${localesPath}`);
      }
      
      // Check if locale files exist
      const uzPath = path.join(localesPath, 'uz.json');
      const uzCyrlPath = path.join(localesPath, 'uz_cyrl.json');
      
      console.log('UZ file exists:', fs.existsSync(uzPath));
      console.log('UZ Cyrl file exists:', fs.existsSync(uzCyrlPath));
      
      if (!fs.existsSync(uzPath)) {
        throw new Error(`❌ UZ locale file not found: ${uzPath}`);
      }
      
      if (!fs.existsSync(uzCyrlPath)) {
        console.warn(`⚠️ UZ Cyrl locale file not found: ${uzCyrlPath}, falling back to UZ`);
      }

      await i18next
        .use(Backend)
        .init({
          lng: 'uz',
          fallbackLng: 'uz',
          preload: ['uz', 'uz_cyrl'],
          ns: ['translation'],
          defaultNS: 'translation',
          backend: {
            loadPath: path.join(localesPath, '{{lng}}.json')
          },
          interpolation: {
            escapeValue: false,
          },
          returnObjects: true,
          returnEmptyString: false,
          returnNull: false,
          debug: true // Enable debug mode
        });
    
      console.log('✅ i18next initialized successfully');
      console.log('Available languages:', i18next.languages);
      console.log('Current language:', i18next.language);
    
      // Test translations
      console.log('🧪 Testing translations:');
      console.log(' - welcome:', i18next.t('welcome'));
      console.log(' - my_orders:', i18next.t('my_orders'));
      console.log(' - phone_share:', i18next.t('phone_share'));
    
      return i18next;
    } catch (error) {
      console.error('❌ Failed to initialize i18n:', error);
      // Re-throw to allow handling in the application
      throw error;
    }
  })();

  return initPromise;
};

// Helper function to translate
async function t(key, options = {}) {
  try {
    // Ensure i18n is initialized
    const i18n = await initializeI18n();
    
    // If we get here, i18n is initialized
    const result = i18n.t(key, options);
    
    // If the key doesn't exist, i18next returns the key itself
    if (result === key) {
      console.warn(`⚠️ Translation key not found: "${key}"`);
    }
    return result;
  } catch (error) {
    console.error(`❌ Error in translation for key "${key}":`, error);
    return key; // Return the key as fallback
  }
}

// Add a synchronous version that can be used when async isn't possible
function tSync(key, options = {}) {
  if (!isInitialized) {
    console.warn(`⚠️ i18n not initialized yet (sync), returning key: "${key}"`);
    return key;
  }
  
  try {
    const result = i18next.t(key, options);
    if (result === key) {
      console.warn(`⚠️ Translation key not found: "${key}"`);
    }
    return result;
  } catch (error) {
    console.error(`❌ Error in sync translation for key "${key}":`, error);
    return key;
  }
}

// Add a function to change language
async function changeLanguage(lng) {
  try {
    const i18n = await initializeI18n();
    await i18n.changeLanguage(lng);
    return true;
  } catch (error) {
    console.error('❌ Failed to change language:', error);
    return false;
  }
}

module.exports = {
  i18next,
  t,
  tSync,
  changeLanguage,
  isInitialized: () => isInitialized,
  waitForInitialization: () => initPromise
};