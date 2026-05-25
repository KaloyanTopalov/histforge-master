// AmbientForge DistroKid Runner — content script.
//
// Receives action messages from the background SW and drives the DistroKid
// release-creation page via DOM manipulation. The form-filling helpers
// (setInputValue, isVisible, findInputForLabel, findSelectForLabel, and the
// selector arrays) are ported from the upstream "AI Music Ext" extension at
// D:\ai-music-ext-main — those are field-tested against real DistroKid UI.
//
// File-upload (upload_cover / upload_track) is intentionally STUBBED. Browser
// security blocks programmatic file selection on <input type="file">, so the
// dry-run Session 6 contract is: the bridge returns requiresManualUpload:true
// and the operator drag-drops the files. The dashboard surfaces a banner with
// the list of files step 06 expected to upload.

(function () {
  'use strict';
  console.log('[distrokid-runner] content script loaded on', window.location.href);

  // ===== INPUT MANIPULATION HELPERS (ported from AI Music Ext) =====

  // Set input value and trigger events to ensure frameworks detect the change.
  // The native input value setter bypasses React's controlled-component value
  // tracker (https://github.com/facebook/react/issues/10135).
  function setInputValue(input, value) {
    input.value = value;
    const events = [
      new Event('input', { bubbles: true }),
      new Event('change', { bubbles: true }),
      new Event('blur', { bubbles: true }),
    ];
    events.forEach((event) => input.dispatchEvent(event));
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    ).set;
    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  function isVisible(element) {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.opacity !== '0' &&
      element.offsetParent !== null
    );
  }

  function findInputForLabel(label) {
    if (label.htmlFor) {
      return document.getElementById(label.htmlFor);
    }
    const nestedInput = label.querySelector('input, textarea');
    if (nestedInput) return nestedInput;
    const sibling = label.nextElementSibling;
    if (sibling && (sibling.tagName === 'INPUT' || sibling.tagName === 'TEXTAREA')) {
      return sibling;
    }
    return null;
  }

  function findSelectForLabel(label) {
    if (label.htmlFor) {
      const el = document.getElementById(label.htmlFor);
      if (el && el.tagName === 'SELECT') return el;
    }
    const nested = label.querySelector('select');
    if (nested) return nested;
    const sibling = label.nextElementSibling;
    if (sibling && sibling.tagName === 'SELECT') return sibling;
    return null;
  }

  function setDropdownValue(dropdown, value) {
    const stringValue = String(value);
    const option = Array.from(dropdown.options).find((o) => o.value === stringValue);
    if (option) {
      dropdown.value = stringValue;
      dropdown.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    // Try matching option text instead of value.
    const byText = Array.from(dropdown.options).find((o) => o.textContent.trim() === stringValue);
    if (byText) {
      dropdown.value = byText.value;
      dropdown.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    return false;
  }

  // ===== FIELD-FILL FUNCTIONS (selectors from AI Music Ext) =====

  function fillAlbumTitle(title) {
    const selectors = [
      'input[name*="album" i][name*="title" i]',
      'input[name*="release" i][name*="title" i]',
      'input[placeholder*="album" i][placeholder*="title" i]',
      'input[placeholder*="release" i][placeholder*="title" i]',
      'input[name*="album" i]:not([type="file"]):not([type="checkbox"]):not([type="radio"])',
      'input[aria-label*="album" i][aria-label*="title" i]',
    ];
    for (const sel of selectors) {
      const input = document.querySelector(sel);
      if (input && isVisible(input)) {
        setInputValue(input, title);
        return true;
      }
    }
    const labels = document.querySelectorAll('label');
    for (const label of labels) {
      const text = label.textContent.toLowerCase();
      if ((text.includes('album') || text.includes('release')) && text.includes('title')) {
        const input = findInputForLabel(label);
        if (input && isVisible(input)) {
          setInputValue(input, title);
          return true;
        }
      }
    }
    return false;
  }

  function fillArtistName(artistName) {
    const directField = document.getElementById('artistName');
    if (directField && isVisible(directField)) {
      setInputValue(directField, artistName);
      return true;
    }
    const selectors = [
      'input[name="artistName"]',
      'input[name*="artist" i][name*="name" i]',
      'input[placeholder*="artist" i][placeholder*="name" i]',
      'input[name*="primary" i][name*="artist" i]',
      'input[name*="artist" i]:not([type="file"]):not([type="checkbox"]):not([type="radio"])',
      'input[id*="artist" i]:not([type="file"]):not([type="checkbox"]):not([type="radio"])',
      'input[placeholder*="artist" i]',
      'input[aria-label*="artist" i]',
    ];
    for (const sel of selectors) {
      const inputs = document.querySelectorAll(sel);
      for (const input of inputs) {
        if (isVisible(input)) {
          setInputValue(input, artistName);
          return true;
        }
      }
    }
    const labels = document.querySelectorAll('label');
    for (const label of labels) {
      const text = label.textContent.toLowerCase().trim();
      const isArtistLabel =
        text.includes('artist') ||
        text === 'primary artist' ||
        text === 'artist name' ||
        text.startsWith('artist') ||
        (text.includes('primary') && text.includes('artist'));
      if (isArtistLabel) {
        const input = findInputForLabel(label);
        if (input && isVisible(input)) {
          setInputValue(input, artistName);
          return true;
        }
      }
    }
    return false;
  }

  function fillTrackTitles(tracks) {
    const selectors = [
      'input[name*="song" i][name*="title" i]',
      'input[name*="track" i][name*="title" i]',
      'input[placeholder*="song" i][placeholder*="title" i]',
      'input[placeholder*="track" i][placeholder*="title" i]',
      'input[name*="song" i]:not([type="file"]):not([type="checkbox"]):not([type="radio"])',
      'input[name*="track" i]:not([type="file"]):not([type="checkbox"]):not([type="radio"])',
    ];
    let trackInputs = [];
    for (const sel of selectors) {
      trackInputs = Array.from(document.querySelectorAll(sel)).filter((i) => isVisible(i));
      if (trackInputs.length > 0) break;
    }
    if (trackInputs.length === 0) {
      const labels = document.querySelectorAll('label');
      for (const label of labels) {
        const text = label.textContent.toLowerCase();
        if (
          (text.includes('song') || text.includes('track')) &&
          (text.includes('title') || text.includes('name'))
        ) {
          const input = findInputForLabel(label);
          if (input && isVisible(input) && !trackInputs.includes(input)) {
            trackInputs.push(input);
          }
        }
      }
    }
    if (trackInputs.length === 0) return 0;
    let filled = 0;
    const max = Math.min(tracks.length, trackInputs.length);
    for (let i = 0; i < max; i++) {
      if (tracks[i] && tracks[i].title) {
        setInputValue(trackInputs[i], tracks[i].title);
        filled++;
      }
    }
    return filled;
  }

  function setNumberOfSongs(numSongs) {
    const selectors = [
      'select[name*="song" i][name*="count" i]',
      'select[name*="track" i][name*="count" i]',
      'select[name*="number" i][name*="song" i]',
      'select[name*="number" i][name*="track" i]',
      'select[name*="songs" i]',
      'select[name*="tracks" i]',
      'select[name*="how" i]',
      'select[id*="song" i]',
      'select[id*="track" i]',
    ];
    for (const sel of selectors) {
      const dropdown = document.querySelector(sel);
      if (dropdown && isVisible(dropdown)) {
        return setDropdownValue(dropdown, numSongs);
      }
    }
    const labels = document.querySelectorAll('label');
    for (const label of labels) {
      const text = label.textContent.toLowerCase();
      if (
        (text.includes('how many') ||
          text.includes('number of') ||
          text.includes('how') ||
          text.includes('upload')) &&
        (text.includes('song') || text.includes('track'))
      ) {
        const select = findSelectForLabel(label);
        if (select && isVisible(select)) {
          return setDropdownValue(select, numSongs);
        }
      }
    }
    return false;
  }

  // ===== Session 4.7 fillers (selectors validated by live DOM probe) =====
  //
  // DistroKid /new/ form is a SPA. Album-level fields (#albumTitleInput) and
  // per-track inputs (`title_<uuid>`, `explicit_<uuid>` radios) only render
  // once #howManySongsOnThisAlbum is set to the desired track count. Drive the
  // songs dropdown FIRST, wait for re-render, then fill the rest.

  function fillGenre(genre) {
    if (!genre) return false;
    const el = document.getElementById('genrePrimary');
    if (el && isVisible(el)) {
      const ok = setDropdownValue(el, genre);
      console.log('[dk-runner] fillGenre genre="' + genre + '" ok=' + ok);
      return ok;
    }
    console.log('[dk-runner] fillGenre: #genrePrimary not visible');
    return false;
  }

  function fillLanguage(language) {
    if (!language) return false;
    const el = document.getElementById('language');
    if (el && isVisible(el)) {
      const ok = setDropdownValue(el, language);
      console.log('[dk-runner] fillLanguage language="' + language + '" ok=' + ok);
      return ok;
    }
    console.log('[dk-runner] fillLanguage: #language not visible');
    return false;
  }

  // DistroKid renders one radio pair per track:
  //   #js-not-explicit-radio-button-N (value=0) and #js-explicit-radio-button-N
  //   (value=1), grouped by name=`explicit_<uuid>`. Click one per track.
  function setExplicitAllTracks(explicit) {
    const targetIdPrefix = explicit ? 'js-explicit-radio-button-' : 'js-not-explicit-radio-button-';
    const radios = Array.from(document.querySelectorAll('input[type="radio"][id^="' + targetIdPrefix + '"]'));
    let clicked = 0;
    for (const r of radios) {
      if (!isVisible(r)) continue;
      if (!r.checked) {
        r.click();
        clicked++;
      } else {
        clicked++; // already in desired state, count as success
      }
    }
    console.log('[dk-runner] setExplicit explicit=' + explicit + ' radios=' + radios.length + ' clicked=' + clicked);
    return clicked;
  }

  function setReleaseDate(releaseDate) {
    if (!releaseDate) return false;
    const el = document.getElementById('release-date-dp');
    if (el && isVisible(el)) {
      setInputValue(el, releaseDate);
      const ok = el.value === releaseDate;
      console.log('[dk-runner] setReleaseDate value="' + releaseDate + '" ok=' + ok);
      return ok;
    }
    console.log('[dk-runner] setReleaseDate: #release-date-dp not visible');
    return false;
  }

  function fillLabel(label) {
    // null/empty intentionally leaves blank, returns true (no-op success).
    if (!label) {
      console.log('[dk-runner] fillLabel: empty, skipping');
      return true;
    }
    const el = document.getElementById('recordLabel');
    if (el && isVisible(el)) {
      setInputValue(el, label);
      console.log('[dk-runner] fillLabel label="' + label + '"');
      return true;
    }
    console.log('[dk-runner] fillLabel: #recordLabel not visible');
    return false;
  }

  // Wait for at least N inputs whose id starts with "title_" to be present.
  // This is the signal that DK has finished re-rendering the form after
  // setNumberOfSongs(N).
  async function waitForTrackInputs(numSongs, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 5000);
    while (Date.now() < deadline) {
      const titles = document.querySelectorAll('input[id^="title_"]');
      if (titles.length >= numSongs) return titles.length;
      await new Promise((r) => setTimeout(r, 100));
    }
    return document.querySelectorAll('input[id^="title_"]').length;
  }

  // DistroKid renders per-track credit rows once the operator clicks
  // "Add credits" on each track. Inputs are id'd by 1-based track + 1-based
  // credit index:
  //   #track-{N}-performer-{idx}-name (text input, placeholder "Name")
  //   #track-{N}-performer-{idx}-role (native <select>, instruments
  //     alphabetical: "Banjo", "Bass", … "Synthesizer", … "Vocals")
  // We fill the first credit row (idx=1) per track. If the row isn't visible,
  // it means the operator hasn't clicked "Add credits" for that track —
  // attempt to click it via a heuristic locator below; otherwise skip with an
  // error so the dashboard banner can prompt manual expansion.
  // DK exposes ONE global "Add credits for each song on this release" toggle.
  // Operator-confirmed HTML (Session 4.7):
  //   <div class="requirements-item-title">
  //     <i class="fa fa-plus"></i>
  //     <i class="fa fa-minus"></i>
  //     <div class="requirement-item-icon"><i class="fa fa-music"></i></div>
  //     Add credits for each song on this release
  //   </div>
  // No id, no role, no onclick attribute — DK wires the click handler at
  // page-load time. Try two click strategies on the title div + on the
  // fa-plus icon (in case the listener is on the icon).
  function tryClickAddCreditsGlobal() {
    const titleEl = Array.from(document.querySelectorAll('.requirements-item-title'))
      .filter((el) => isVisible(el))
      .find((el) => /add\s+credit/i.test(el.textContent || ''));
    if (!titleEl) {
      console.log('[dk-runner] tryClickAddCreditsGlobal: no .requirements-item-title matched "add credit"');
      return false;
    }
    const fireOn = (el) => {
      const rect = el.getBoundingClientRect();
      const opts = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: rect.left + Math.max(1, rect.width / 2),
        clientY: rect.top + Math.max(1, rect.height / 2),
        button: 0,
      };
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.dispatchEvent(new MouseEvent('click', opts));
      try {
        el.click();
      } catch (_e) {
        // ignore
      }
    };
    // The parent .requirements-item is toggled between class
    // "requirements-item" (closed) and "requirements-item open" (expanded)
    // by DK's click handler — operator-verified Session 4.7. Use parent
    // class as the post-click verification signal.
    const parent = titleEl.parentElement;
    const isOpen = () =>
      parent && (parent.className || '').split(/\s+/).includes('open');
    if (isOpen()) {
      console.log('[dk-runner] tryClickAddCreditsGlobal: already open, no click needed');
      return true;
    }
    // Strategy 1: click the title div with full mouse-event sequence.
    fireOn(titleEl);
    if (isOpen()) {
      console.log('[dk-runner] tryClickAddCreditsGlobal: opened via title-div click');
      return true;
    }
    // Strategy 2: click the fa-plus icon (DK's toggle indicator) — the
    // click handler may be delegated to the icon specifically.
    const plusIcon = titleEl.querySelector('i.fa-plus');
    if (plusIcon) {
      fireOn(plusIcon);
      if (isOpen()) {
        console.log('[dk-runner] tryClickAddCreditsGlobal: opened via .fa-plus click');
        return true;
      }
    }
    // Strategy 3: click the parent .requirements-item directly.
    if (parent) {
      fireOn(parent);
      if (isOpen()) {
        console.log('[dk-runner] tryClickAddCreditsGlobal: opened via parent click');
        return true;
      }
    }
    console.log(
      '[dk-runner] tryClickAddCreditsGlobal: dispatched 3 strategies but parent.classList does not include "open" — DK may filter synthetic clicks',
    );
    return false;
  }

  async function fillCreditsAllTracks(performerName, performerRole, producerName, producerRole, numTracks) {
    const result = {
      performerNameFilled: 0,
      performerRoleFilled: 0,
      producerNameFilled: 0,
      producerRoleFilled: 0,
      missing: [],
      expanded: 0,
    };
    const fillCredit = (kind, n, name, role) => {
      const nameEl = document.getElementById('track-' + n + '-' + kind + '-1-name');
      const roleEl = document.getElementById('track-' + n + '-' + kind + '-1-role');
      let nameOk = false;
      let roleOk = false;
      if (name && nameEl && isVisible(nameEl)) {
        setInputValue(nameEl, name);
        nameOk = true;
      } else if (name) {
        result.missing.push('track' + n + '_' + kind + '_name');
      }
      if (role && roleEl && isVisible(roleEl)) {
        if (setDropdownValue(roleEl, role)) roleOk = true;
        else result.missing.push('track' + n + '_' + kind + '_role_no_match_' + role);
      } else if (role) {
        result.missing.push('track' + n + '_' + kind + '_role');
      }
      return { nameOk, roleOk };
    };
    // Pre-flight: if track 1's performer name input isn't visible, the
    // operator hasn't expanded credits — try the global "Add credits"
    // toggle once for the whole album. Wait for the DOM to render the rows.
    const probe = document.getElementById('track-1-performer-1-name');
    if (!probe || !isVisible(probe)) {
      if (tryClickAddCreditsGlobal()) {
        result.expanded = 1;
        await new Promise((r) => setTimeout(r, 600));
      }
    }
    for (let n = 1; n <= numTracks; n++) {
      if (performerName && performerRole) {
        const { nameOk, roleOk } = fillCredit('performer', n, performerName, performerRole);
        if (nameOk) result.performerNameFilled++;
        if (roleOk) result.performerRoleFilled++;
      }
      if (producerName && producerRole) {
        const { nameOk, roleOk } = fillCredit('producer', n, producerName, producerRole);
        if (nameOk) result.producerNameFilled++;
        if (roleOk) result.producerRoleFilled++;
      }
    }
    console.log(
      '[dk-runner] credits fill: tracks=' +
        numTracks +
        ' perfName=' +
        result.performerNameFilled +
        ' perfRole=' +
        result.performerRoleFilled +
        ' prodName=' +
        result.producerNameFilled +
        ' prodRole=' +
        result.producerRoleFilled +
        ' expanded=' +
        result.expanded +
        ' missing=' +
        result.missing.join(','),
    );
    return result;
  }

  // DistroKid renders one songwriter group per track:
  //   <input name="songwriter_real_name_first1" placeholder="First name">
  //   <input name="songwriter_real_name_middle1" placeholder="Middle name">
  //   <input name="songwriter_real_name_last1" placeholder="Last name">
  // 1-based index. Replicate the same operator name across every track.
  function fillSongwriterAllTracks(firstName, middleName, lastName, numTracks) {
    const result = { firstFilled: 0, middleFilled: 0, lastFilled: 0, missing: [] };
    for (let n = 1; n <= numTracks; n++) {
      if (firstName) {
        const el = document.querySelector('input[name="songwriter_real_name_first' + n + '"]');
        if (el && isVisible(el)) {
          setInputValue(el, firstName);
          result.firstFilled++;
        } else {
          result.missing.push('first' + n);
        }
      }
      if (middleName) {
        const el = document.querySelector('input[name="songwriter_real_name_middle' + n + '"]');
        if (el && isVisible(el)) {
          setInputValue(el, middleName);
          result.middleFilled++;
        }
      }
      if (lastName) {
        const el = document.querySelector('input[name="songwriter_real_name_last' + n + '"]');
        if (el && isVisible(el)) {
          setInputValue(el, lastName);
          result.lastFilled++;
        } else {
          result.missing.push('last' + n);
        }
      }
    }
    console.log(
      '[dk-runner] songwriter fill: tracks=' +
        numTracks +
        ' first=' +
        result.firstFilled +
        ' middle=' +
        result.middleFilled +
        ' last=' +
        result.lastFilled +
        ' missing=' +
        result.missing.join(','),
    );
    return result;
  }

  // ===== ACTION HANDLERS =====

  async function handleVerifyArtist(payload) {
    // DistroKid's artist dropdown is a native <select id="artistName" name="bandname">
    // populated with the operator's saved artist profiles. Exact-match the
    // requested name against option textContent. False positives are
    // dangerous — if the option list is empty (page not loaded yet) or the
    // name doesn't match, return found:false with the candidate list so the
    // caller surfaces a banner.
    const wanted = (payload && payload.artistName) || '';
    const el = document.getElementById('artistName');
    if (!el || !isVisible(el)) {
      console.log('[dk-runner] verify_artist: #artistName not visible (page may still be loading)');
      return { found: false, candidates: [], primarySelected: false, reason: 'ARTIST_DROPDOWN_NOT_VISIBLE' };
    }
    const candidates = Array.from(el.options)
      .map((o) => (o.textContent || '').trim())
      .filter((t) => t.length > 0);
    const found = candidates.includes(wanted);
    const primarySelected = (el.value || '').trim() === wanted;
    console.log(
      '[dk-runner] verify_artist: opened #artistName, found ' +
        candidates.length +
        ' options, exact-match for "' +
        wanted +
        '" = ' +
        found +
        ' primarySelected=' +
        primarySelected,
    );
    return { found, candidates, primarySelected };
  }

  async function handleStartRelease(_payload) {
    // DistroKid's release-creation flow lives at /new/ as a single SPA. If we
    // arrive on a different path, navigate; otherwise wait for the form's
    // first signal (#howManySongsOnThisAlbum) to be present. Token = current
    // URL so subsequent actions can re-verify they're on the right page.
    const ON_NEW_PATH = /^\/new\/?($|\?)/i;
    if (!ON_NEW_PATH.test(location.pathname)) {
      console.log('[dk-runner] start_release: not on /new/, navigating');
      location.href = '/new/';
      // Navigation tears down this content script — the next action will
      // re-attach. Return a synthetic ready=false so caller can retry.
      return { releaseToken: location.href, ready: false, navigating: true };
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const songs = document.getElementById('howManySongsOnThisAlbum');
      if (songs && isVisible(songs)) {
        console.log('[dk-runner] start_release: form ready at ' + location.href);
        return { releaseToken: location.href, ready: true };
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    console.log('[dk-runner] start_release: timed out waiting for #howManySongsOnThisAlbum');
    return { releaseToken: location.href, ready: false, reason: 'FORM_NOT_READY' };
  }

  async function handleSetMetadata(payload) {
    // payload = the raw DistrokidMetadata sent by step 06: { albumTitle,
    // artistName, genre, language, explicit, releaseDate, label, numSongs }.
    // Bridge passes the request body straight through, no nesting.
    const md = payload || {};
    const filled = {};
    const errors = [];

    // 1. Drive #howManySongsOnThisAlbum to the requested track count FIRST,
    //    but only if it's not already at that value. Re-firing change on the
    //    same value re-renders the form and collapses any per-track credit
    //    rows the operator (or earlier set_metadata calls) had expanded.
    const numSongs = Number(md.numSongs || 0);
    if (numSongs >= 1 && numSongs <= 35) {
      const dropdown = document.getElementById('howManySongsOnThisAlbum');
      const alreadyMatch = dropdown && String(dropdown.value || '') === String(numSongs);
      if (alreadyMatch) {
        filled.numSongs = numSongs;
        console.log('[dk-runner] set_metadata: numSongs already=' + numSongs + ', skipping re-drive (preserves expanded credits)');
      } else {
        let songsOk = setNumberOfSongs(numSongs);
        if (!songsOk) {
          // Fallback: direct ID lookup.
          if (dropdown && isVisible(dropdown)) {
            dropdown.value = String(numSongs);
            dropdown.dispatchEvent(new Event('change', { bubbles: true }));
            songsOk = String(dropdown.value || '') === String(numSongs);
          }
        }
        if (songsOk) {
          filled.numSongs = numSongs;
          const rendered = await waitForTrackInputs(numSongs, 5000);
          console.log('[dk-runner] set_metadata: numSongs=' + numSongs + ' rendered ' + rendered + ' track inputs');
          if (rendered < numSongs) {
            errors.push('numSongs_render_short_' + rendered + '_of_' + numSongs);
          }
        } else {
          errors.push('numSongs_dropdown_failed');
        }
      }
    } else if (numSongs !== 0) {
      errors.push('numSongs_out_of_range_' + numSongs);
    }

    // 2. Album title (only renders for ≥2 songs, validated above).
    if (md.albumTitle) {
      if (fillAlbumTitle(md.albumTitle)) filled.albumTitle = md.albumTitle;
      else errors.push('albumTitle_not_filled');
    }

    // 3. Artist name — use the native select.
    if (md.artistName) {
      const el = document.getElementById('artistName');
      if (el && isVisible(el) && setDropdownValue(el, md.artistName)) {
        filled.artistName = md.artistName;
      } else if (fillArtistName(md.artistName)) {
        // Fallback to AI Music Ext label-traversal helper.
        filled.artistName = md.artistName;
      } else {
        errors.push('artistName_not_filled');
      }
    }

    // 4. Genre.
    if (md.genre) {
      if (fillGenre(md.genre)) filled.genre = md.genre;
      else errors.push('genre_not_in_dropdown_' + md.genre);
    }

    // 5. Language.
    if (md.language) {
      if (fillLanguage(md.language)) filled.language = md.language;
      else errors.push('language_not_in_dropdown_' + md.language);
    }

    // 6. Explicit toggle on every per-track radio pair.
    const explicitClicked = setExplicitAllTracks(Boolean(md.explicit));
    if (explicitClicked > 0) filled.explicit = Boolean(md.explicit);
    else errors.push('explicit_no_radios_found');

    // 7. Release date.
    if (md.releaseDate) {
      if (setReleaseDate(md.releaseDate)) filled.releaseDate = md.releaseDate;
      else errors.push('releaseDate_not_filled');
    }

    // 8. Label (optional, blank is valid).
    if (fillLabel(md.label || '')) filled.label = md.label || '';
    else errors.push('label_not_filled');

    // 9. Songwriter (per-track real name, replicated to all tracks). DistroKid
    //    requires at least first + last name per track for publishing rights.
    if (md.songwriterFirstName || md.songwriterLastName) {
      const tracks = Number(md.numSongs || 0);
      const sw = fillSongwriterAllTracks(
        md.songwriterFirstName || '',
        md.songwriterMiddleName || '',
        md.songwriterLastName || '',
        tracks,
      );
      filled.songwriter = {
        firstFilled: sw.firstFilled,
        lastFilled: sw.lastFilled,
        firstName: md.songwriterFirstName || null,
        lastName: md.songwriterLastName || null,
      };
      if (sw.missing.length > 0) errors.push('songwriter_missing_' + sw.missing.join('|'));
    }

    // 10. Performer + Producer credits (per-track, replicated). Operator must
    //     have clicked "Add credits for each song on this release" so the
    //     credit rows are rendered; the filler attempts a best-effort
    //     auto-click before falling back to error.
    if (
      (md.creditPerformerName && md.creditPerformerRole) ||
      (md.creditProducerName && md.creditProducerRole)
    ) {
      // If payload omits numSongs (e.g. retry-only credits call), derive
      // track count from the rendered title inputs in the DOM.
      let tracks = Number(md.numSongs || 0);
      if (tracks <= 0) {
        tracks = document.querySelectorAll('input[id^="title_"]').length;
        console.log('[dk-runner] credits: numSongs absent, derived tracks=' + tracks + ' from DOM');
      }
      const cr = await fillCreditsAllTracks(
        md.creditPerformerName || '',
        md.creditPerformerRole || '',
        md.creditProducerName || '',
        md.creditProducerRole || '',
        tracks,
      );
      filled.credits = {
        performer: { name: md.creditPerformerName || null, role: md.creditPerformerRole || null, nameFilled: cr.performerNameFilled, roleFilled: cr.performerRoleFilled },
        producer: { name: md.creditProducerName || null, role: md.creditProducerRole || null, nameFilled: cr.producerNameFilled, roleFilled: cr.producerRoleFilled },
        expanded: cr.expanded,
      };
      if (cr.missing.length > 0) errors.push('credits_missing_' + cr.missing.join('|'));
    }

    const fieldNames = ['albumTitle', 'artistName', 'genre', 'language', 'explicit', 'releaseDate', 'label'];
    const fieldsFilled = fieldNames.filter((f) => f in filled).length;
    const missingFields = fieldNames.filter((f) => !(f in filled));

    console.log(
      '[dk-runner] set_metadata: fieldsFilled=' +
        fieldsFilled +
        '/7 missing=[' +
        missingFields.join(',') +
        '] errors=[' +
        errors.join(',') +
        ']',
    );

    return { ok: true, filled, fieldsFilled, fieldsAttempted: 7, missingFields, errors };
  }

  async function handleUploadCover(_payload) {
    // Browser security blocks programmatic file input. Operator must drag
    // the cover into DistroKid's drop zone manually. The bridge surfaces
    // requiresManualUpload:true so step 06 trusts the response and proceeds.
    console.log('[dk-runner] upload_cover: manual upload required (operator drag-drop)');
    return { ok: true, requiresManualUpload: true };
  }

  async function handleUploadTrack(payload) {
    const n = payload && payload.trackNumber;
    console.log('[dk-runner] upload_track: manual upload required for track ' + n);
    return { ok: true, trackNumber: n, requiresManualUpload: true };
  }

  async function handleVerifyTrackCount(payload) {
    const expected = Number((payload && payload.expected) || 0);
    // DistroKid renders one input[id^="title_<uuid>"] per track slot. Count
    // those — they appear as soon as the songs dropdown is set, regardless of
    // whether files have been uploaded yet (DK auto-fills the title from the
    // filename on drop, but the slot exists earlier). For dry-run that's the
    // best signal we can derive without observing post-upload mutations.
    const titleInputs = document.querySelectorAll('input[id^="title_"]');
    const count = titleInputs.length;
    const matches = count === expected;
    console.log('[dk-runner] verify_track_count: expected=' + expected + ' count=' + count + ' matches=' + matches);
    return { count, matches };
  }

  async function handleSubmitOrScreenshot(payload, actionId) {
    // 1. Captcha gate. DK uses Google's invisible reCAPTCHA v2 — div, not
    //    iframe. It only renders an interactive challenge when the score is
    //    too low; otherwise the form just submits silently. So we surface
    //    captcha_required only if the iframe is actually visible to the user.
    const visibleCaptchaSelectors = [
      'iframe[src*="recaptcha"][title*="recaptcha challenge" i]',
      'iframe[src*="hcaptcha"]',
      'div[class*="g-recaptcha" i]:not([style*="display: none"])',
    ];
    for (const sel of visibleCaptchaSelectors) {
      const el = document.querySelector(sel);
      if (el && isVisible(el) && el.offsetWidth > 50 && el.offsetHeight > 50) {
        console.log('[dk-runner] submit_or_screenshot: captcha visible at ' + sel);
        return { status: 'captcha_required' };
      }
    }

    // 2. Capture screenshot. content.js has no permission for
    //    chrome.tabs.captureVisibleTab — broker through background.js, which
    //    captures the dataUrl and POSTs raw bytes to the bridge's
    //    /upload-screenshot/<actionId> endpoint. The bridge writes to the
    //    payload's screenshotPath.
    const screenshotPath = payload && payload.screenshotPath;
    if (!screenshotPath) {
      console.log('[dk-runner] submit_or_screenshot: no screenshotPath in payload');
      return { status: 'screenshot_saved', screenshotPath: null, captured: false, reason: 'NO_PATH' };
    }
    if (!actionId) {
      console.log('[dk-runner] submit_or_screenshot: no actionId — screenshot capture cannot correlate');
      return { status: 'screenshot_saved', screenshotPath, captured: false, reason: 'NO_ACTION_ID' };
    }
    console.log('[dk-runner] submit_or_screenshot: requesting capture from background actionId=' + actionId);
    const captureResult = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { kind: 'capture_screenshot', actionId, screenshotPath },
        (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || { ok: false, error: 'no response' });
        },
      );
    });
    if (!captureResult.ok) {
      console.log('[dk-runner] submit_or_screenshot: capture failed — ' + captureResult.error);
      return {
        status: 'screenshot_saved',
        screenshotPath,
        captured: false,
        reason: captureResult.error || 'CAPTURE_FAILED',
      };
    }
    console.log('[dk-runner] submit_or_screenshot: captured ' + (captureResult.bytes || '?') + ' bytes to ' + screenshotPath);
    return { status: 'screenshot_saved', screenshotPath, captured: true, bytes: captureResult.bytes };
  }

  // ===== MESSAGE ROUTER =====

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    handle(msg)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: String(err.message ?? err) }));
    return true; // keep channel open for async sendResponse
  });

  async function handle(msg) {
    switch (msg && msg.kind) {
      case 'verify_artist':
        return handleVerifyArtist(msg.payload);
      case 'start_release':
        return handleStartRelease(msg.payload);
      case 'set_metadata':
        return handleSetMetadata(msg.payload);
      case 'upload_cover':
        return handleUploadCover(msg.payload);
      case 'upload_track':
        return handleUploadTrack(msg.payload);
      case 'verify_track_count':
        return handleVerifyTrackCount(msg.payload);
      case 'submit_or_screenshot':
        return handleSubmitOrScreenshot(msg.payload, msg.actionId);
      case 'ping':
        return { pong: true };
      default:
        throw new Error('UNKNOWN_MESSAGE: ' + JSON.stringify(msg));
    }
  }
})();
