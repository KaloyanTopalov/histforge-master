// VEO reCAPTCHA Hook - Runs at document_start in MAIN world
// Intercepts grecaptcha.enterprise.execute BEFORE Google's code loads
// Captures the correct action parameter

(function() {
  'use strict';

  // Store captured actions
  window.__VEO_RECAPTCHA_ACTIONS = [];
  window.__VEO_LAST_ACTION = null;

  // Hook grecaptcha before it even exists using Object.defineProperty trap
  let realGrecaptcha = window.grecaptcha;

  if (!realGrecaptcha) {
    // grecaptcha doesn't exist yet - set a trap for when it gets created
    Object.defineProperty(window, 'grecaptcha', {
      configurable: true,
      enumerable: true,
      get: function() {
        return realGrecaptcha;
      },
      set: function(val) {
        console.log('[YouForge Flow] [recaptcha-hook] grecaptcha being set!', val ? Object.keys(val) : 'null');
        realGrecaptcha = val;
        // Hook enterprise.execute when it becomes available
        hookEnterprise(val);
      }
    });
  } else {
    hookEnterprise(realGrecaptcha);
  }

  function hookEnterprise(obj) {
    if (!obj) return;

    // If enterprise already exists, hook execute directly
    if (obj.enterprise?.execute) {
      wrapExecute(obj.enterprise);
      return;
    }

    // If enterprise doesn't exist yet, trap it
    let realEnterprise = obj.enterprise;
    Object.defineProperty(obj, 'enterprise', {
      configurable: true,
      enumerable: true,
      get: function() {
        return realEnterprise;
      },
      set: function(val) {
        console.log('[YouForge Flow] [recaptcha-hook] grecaptcha.enterprise being set!');
        realEnterprise = val;
        if (val?.execute) {
          wrapExecute(val);
        }
      }
    });
  }

  function wrapExecute(enterprise) {
    if (enterprise._veoWrapped) return;
    const original = enterprise.execute;

    enterprise.execute = function(siteKey, options) {
      const action = options?.action || '(no action)';
      console.log('%c[YouForge Flow] [recaptcha-hook] grecaptcha.enterprise.execute called!', 'background: #e74c3c; color: white; font-size: 14px;');
      console.log('[YouForge Flow] [recaptcha-hook]   siteKey:', siteKey);
      console.log('[YouForge Flow] [recaptcha-hook]   action:', action);
      console.log('[YouForge Flow] [recaptcha-hook]   options:', JSON.stringify(options));

      window.__VEO_LAST_ACTION = action;
      window.__VEO_RECAPTCHA_ACTIONS.push({
        action: action,
        siteKey: siteKey,
        time: new Date().toISOString()
      });

      return original.call(this, siteKey, options);
    };

    enterprise._veoWrapped = true;
    console.log('[YouForge Flow] [recaptcha-hook] grecaptcha.enterprise.execute wrapped successfully!');
  }

  console.log('[YouForge Flow] [recaptcha-hook] reCAPTCHA hook installed (document_start)');
})();
