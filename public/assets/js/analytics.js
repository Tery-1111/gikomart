/* GikoMart analytics (PostHog EU cloud). Loaded with defer BEFORE app.js.
 * Ships disabled. Anonymous only: no identify(), no autocapture, no replay.
 */
(function () {
  'use strict';

  // ---- Switches: edit here only ----
  const ANALYTICS_ENABLED = true;
  const POSTHOG_TOKEN = 'phc_Cod6SxD4PHBXy288J4C5FRRrHSNU9ufDo33UmfukMhqD';
  const POSTHOG_API_HOST = 'https://eu.i.posthog.com';
  const PLACEHOLDER_TOKEN = 'phc_REPLACE_WITH_EU_PROJECT_TOKEN';

  // ---- URL scrubbing ----
  const STRIP_KEYS = [
    '$current_url', '$pathname', '$host', '$referrer', '$referring_domain',
    '$initial_current_url', '$initial_pathname', '$initial_host',
    '$initial_referrer', '$initial_referring_domain'
  ];

  function stripKeys(obj) {
    if (!obj || typeof obj !== 'object') return;
    for (let i = 0; i < STRIP_KEYS.length; i++) {
      delete obj[STRIP_KEYS[i]];
    }
  }

  function beforeSend(event) {
    try {
      if (!event || typeof event !== 'object') return event;
      stripKeys(event.properties);
      if (event.properties) {
        stripKeys(event.properties.$set);
        stripKeys(event.properties.$set_once);
      }
      stripKeys(event.$set);
      stripKeys(event.$set_once);
    } catch (e) {
      return null;
    }
    return event;
  }

  function buildConfig() {
    return {
      api_host: POSTHOG_API_HOST,
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      disable_session_recording: true,
      persistence: 'memory',
      person_profiles: 'never',
      rageclick: false,
      capture_dead_clicks: false,
      capture_heatmaps: false,
      capture_exceptions: false,
      capture_performance: false,
      disable_surveys: true,
      advanced_disable_flags: true,
      disable_web_experiments: true,
      advanced_disable_toolbar_metrics: true,
      before_send: beforeSend
    };
  }

  // ---- Helpers ----
  function priceBand(p) {
    if (p === null || p === undefined || p === '') return 'unknown';
    const n = Number(p);
    if (!isFinite(n) || n < 0) return 'unknown';
    if (n < 1000) return '<1,000';
    if (n < 5000) return '1,000-4,999';
    if (n < 15000) return '5,000-14,999';
    if (n < 50000) return '15,000-49,999';
    return '>=50,000';
  }

  function capture(name, props) {
    try {
      const ph = window.posthog;
      if (ph && typeof ph.capture === 'function') ph.capture(name, props);
    } catch (e) { /* analytics must never break the app */ }
  }

  const pendingProps = {};
  const seenCreated = {};

  function guardFirst(listingId) {
    const key = 'giko_an_created:' + listingId;
    try {
      if (window.sessionStorage.getItem(key)) return false;
      window.sessionStorage.setItem(key, '1');
      return true;
    } catch (e) {
      if (seenCreated[key]) return false;
      seenCreated[key] = true;
      return true;
    }
  }

  const VIEW_SURFACES = { browse: true, store_section: true, store_page: true };

  const api = {
    listingViewed: function (listing, surface) {
      try {
        if (!listing || !listing._id) return;
        if (!Object.prototype.hasOwnProperty.call(VIEW_SURFACES, surface)) return;
        capture('listing_viewed', {
          listing_id: String(listing._id),
          category: typeof listing.category === 'string' ? listing.category : 'unknown',
          price_band: priceBand(listing.price),
          source: surface
        });
      } catch (e) {}
    },

    contactClicked: function (listingId) {
      try {
        if (!listingId) return;
        capture('seller_contact_clicked', {
          listing_id: String(listingId),
          source: 'detail'
        });
      } catch (e) {}
    },

    cachePending: function (invoiceId, category, price) {
      try {
        if (!invoiceId) return;
        pendingProps[String(invoiceId)] = {
          category: typeof category === 'string' ? category : 'unknown',
          price_band: priceBand(price)
        };
      } catch (e) {}
    },

    listingCreated: function (listingId, source, invoiceId, category, price) {
      try {
        if (!listingId) return;
        if (source !== 'paid' && source !== 'store') return;
        const id = String(listingId);
        if (!guardFirst(id)) return;
        const props = { listing_id: id, source: source };
        if (source === 'paid') {
          const cached = pendingProps[String(invoiceId)];
          if (cached) {
            props.category = cached.category;
            props.price_band = cached.price_band;
          }
        } else {
          props.category = typeof category === 'string' ? category : 'unknown';
          props.price_band = priceBand(price);
        }
        capture('listing_created', props);
      } catch (e) {}
    },

    _beforeSend: beforeSend,
    _buildConfig: buildConfig,
    _priceBand: priceBand
  };

  window.gikoAnalytics = api;

  // ---- Loader (runs only when explicitly enabled) ----
  function isLocalHost() {
    const h = window.location && window.location.hostname;
    return h === 'localhost' || h === '127.0.0.1';
  }

  function loadAndInit() {
    /* ===== OFFICIAL SNIPPET (verbatim from posthog.com docs, Option 1, fetched 2026-10-12) ===== */
    /* eslint-disable eqeqeq -- official PostHog snippet, kept verbatim */
    !function(t,e){let o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){const o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/1.438.8/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);let u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],Object.defineProperty(u,"toString",{configurable:!0,enumerable:!0,writable:!0,value:function(t){let e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e}}),Object.defineProperty(u.people,"toString",{configurable:!0,enumerable:!0,writable:!0,value:function(){return u.toString(1)+".people (stub)"}}),o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagResult isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
    window.posthog.init(POSTHOG_TOKEN, buildConfig());
    /* eslint-enable eqeqeq */
  }

  try {
    if (ANALYTICS_ENABLED === true && POSTHOG_TOKEN !== PLACEHOLDER_TOKEN && !isLocalHost()) {
      loadAndInit();
    }
  } catch (e) {}
})();
