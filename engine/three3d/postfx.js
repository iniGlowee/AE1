/**
 * AE1 - PostFX (§18.47): the shader layer — a single filmic uber-pass over
 * the finished frame, modeled on the ReShade stack Austin runs on the reference action game
 * itself (CinematicDOF + film grain + subtle Prism CA + grade).
 *
 * Architecture: renderFrame's final `renderer.render(scene, camera)` routes
 * through here when a PostFX element is live. The scene renders into a
 * color+DEPTH target (WebGL2 depth texture), then one fullscreen triangle
 * composites to screen:
 *
 *   - FOCAL DOF: per-pixel circle-of-confusion from |viewZ − focusDist|,
 *     12-tap poisson blur scaled by CoC. The focus distance arrives from
 *     the PostFX element, which follows the camera→character focal with a
 *     smoothed transition (the CinematicDOF autofocus feel).
 *   - FILM GRAIN: animated hash noise, luma-weighted.
 *   - VIGNETTE + radial CHROMATIC ABERRATION: the lens, gently.
 *
 * Zero-cost when off: no element, no targets allocated, renderFrame's
 * plain render runs exactly as before. New effects are new uniforms + a
 * few shader lines — the scaffolding is the point.
 */

export function createPostFX(THREE, renderer) {
  const _size = new THREE.Vector2(); // reused per frame — no alloc
  let target = null;
  let quadScene = null;
  let quadCam = null;
  let quadMesh = null;
  let material = null;
  let w = 0;
  let h = 0;
  let time = 0;
  // -- bloom chain (§18.50): bright-pass at half res, two blur bounces at
  // quarter, added back in the uber-pass. the reference action game marks glow via emissive
  // materials; three.js renders emissive into the color buffer, so the
  // threshold extract picks exactly those surfaces up.
  let brightRT = null;
  let blurA = null;
  let blurB = null;
  let brightMat = null;
  let blurMat = null;
  let dofRT = null;   // §18.94 half-res DOF field
  let dofMat = null;

  function ensure(width, height) {
    if (target && w === width && h === height) return;
    w = width;
    h = height;
    target?.depthTexture?.dispose();
    target?.dispose();
    brightRT?.dispose();
    blurA?.dispose();
    blurB?.dispose();
    // §18.87: the scene target carries the REAL antialiasing (4x MSAA,
    // resolved into the depth texture by r180's blit) — the canvas's own
    // `antialias` is off, since the only thing drawn there is the
    // fullscreen composite triangle. HalfFloat keeps the linear
    // intermediate from banding in shadows and clipping emissives at 1.0
    // (8-bit LINEAR was neither sRGB-perceptual nor HDR — the worst of
    // both). No stencil: nothing in the engine uses one.
    const depthTexture = new THREE.DepthTexture(w, h);
    depthTexture.type = THREE.UnsignedIntType;
    depthTexture.format = THREE.DepthFormat;
    target = new THREE.WebGLRenderTarget(w, h, {
      depthTexture,
      depthBuffer: true,
      stencilBuffer: false,
      samples: 4,
      type: THREE.HalfFloatType,
    });
    brightRT = new THREE.WebGLRenderTarget(w >> 1, h >> 1, { depthBuffer: false });
    blurA = new THREE.WebGLRenderTarget(w >> 2, h >> 2, { depthBuffer: false });
    blurB = new THREE.WebGLRenderTarget(w >> 2, h >> 2, { depthBuffer: false });
    // §18.94 HALF-RES DOF: the 12-tap CoC gather (26 texture fetches/pixel)
    // runs here at quarter the pixels, then the composite bilinearly
    // upsamples and mixes it in by CoC — the expensive blur leaves the
    // full-res pass. HalfFloat so the blurred HDR stays linear-correct.
    dofRT?.dispose();
    dofRT = new THREE.WebGLRenderTarget(w >> 1, h >> 1,
      { depthBuffer: false, type: THREE.HalfFloatType });
    if (material) {
      material.uniforms.tDiffuse.value = target.texture;
      material.uniforms.tDepth.value = target.depthTexture;
      material.uniforms.resolution.value.set(w, h);
    }
  }

  function ensureBloomMats() {
    if (brightMat) return;
    brightMat = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: { tSrc: { value: null }, threshold: { value: 0.75 } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform sampler2D tSrc;
        uniform float threshold;
        void main() {
          vec3 c = texture2D(tSrc, vUv).rgb;
          float l = dot(c, vec3(0.299, 0.587, 0.114));
          float k = smoothstep(threshold, threshold + 0.25, l);
          gl_FragColor = vec4(c * k, 1.0);
        }`,
    });
    blurMat = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: { tSrc: { value: null }, dir: { value: new THREE.Vector2(1, 0) }, texel: { value: new THREE.Vector2(1, 1) } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform sampler2D tSrc;
        uniform vec2 dir, texel;
        void main() {
          vec2 d = dir * texel;
          vec3 acc = texture2D(tSrc, vUv).rgb * 0.227027;
          acc += (texture2D(tSrc, vUv + d * 1.3846).rgb + texture2D(tSrc, vUv - d * 1.3846).rgb) * 0.3162162;
          acc += (texture2D(tSrc, vUv + d * 3.2308).rgb + texture2D(tSrc, vUv - d * 3.2308).rgb) * 0.0702703;
          gl_FragColor = vec4(acc, 1.0);
        }`,
    });
  }

  // §18.94: the half-res DOF gather — the CoC math and 12-tap poisson disc,
  // lifted verbatim from the old inline composite but run at half res.
  // Outputs the fully blurred field; the composite mixes it by CoC.
  function ensureDofMat() {
    if (dofMat) return;
    dofMat = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tDiffuse: { value: null }, tDepth: { value: null },
        resolution: { value: new THREE.Vector2(1, 1) },
        camNear: { value: 0.1 }, camFar: { value: 1000 },
        focusDist: { value: 4 }, aperture: { value: 0.35 },
        maxBlur: { value: 7 }, sharpRange: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D tDiffuse, tDepth;
        uniform vec2 resolution;
        uniform float camNear, camFar, focusDist, aperture, maxBlur, sharpRange;
        float viewZ(vec2 uv) {
          float d = texture2D(tDepth, uv).x;
          float zN = d * 2.0 - 1.0;
          return (2.0 * camNear * camFar) / (camFar + camNear - zN * (camFar - camNear));
        }
        float cocAt(vec2 uv) {
          float z = viewZ(uv);
          float err = z - focusDist;
          float side = err < 0.0 ? 1.35 : 1.0;
          float mag = max(abs(err) - sharpRange, 0.0);
          return clamp(mag / max(z, 0.05) * aperture * side * resolution.y * 0.1,
                       0.0, maxBlur);
        }
        void main() {
          // resolution is the FULL render res (not the half-res target):
          // the gather samples tDiffuse in full-res-pixel units, it just runs
          // at a quarter of the fragments. That IS the whole optimization.
          vec2 px = 1.0 / resolution;
          float coc = cocAt(vUv);
          if (coc <= 0.5) { gl_FragColor = vec4(texture2D(tDiffuse, vUv).rgb, coc); return; }
          const vec2 taps[12] = vec2[12](
            vec2(-0.326, -0.406), vec2(-0.840, -0.074), vec2(-0.696, 0.457),
            vec2(-0.203, 0.621), vec2(0.962, -0.195), vec2(0.473, -0.480),
            vec2(0.519, 0.767), vec2(0.185, -0.893), vec2(0.507, 0.064),
            vec2(0.896, 0.412), vec2(-0.322, -0.933), vec2(-0.792, -0.598));
          vec3 acc = texture2D(tDiffuse, vUv).rgb;
          float wsum = 1.0;
          for (int i = 0; i < 12; i++) {
            vec2 uv2 = vUv + taps[i] * coc * px;
            float w2 = clamp(cocAt(uv2) / max(coc, 0.001), 0.35, 1.0);
            acc += texture2D(tDiffuse, uv2).rgb * w2;
            wsum += w2;
          }
          gl_FragColor = vec4(acc / wsum, coc); // alpha carries CoC for the mix
        }`,
    });
  }

  function renderPass(mat, dst) {
    quadMesh.material = mat;
    renderer.setRenderTarget(dst);
    renderer.render(quadScene, quadCam);
    quadMesh.material = material;
  }

  function ensureQuad() {
    if (quadScene) return;
    quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    material = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: null },
        resolution: { value: new THREE.Vector2(1, 1) },
        camNear: { value: 0.1 },
        camFar: { value: 1000 },
        focusDist: { value: 4 },
        aperture: { value: 0.35 },
        maxBlur: { value: 7 },
        sharpRange: { value: 0 },
        dofOn: { value: 1 },
        grainAmount: { value: 0.1 },
        vignette: { value: 0.25 },
        caAmount: { value: 0.12 },
        time: { value: 0 },
        tBloom: { value: null },
        bloomStrength: { value: 0 },
        // §18.87: grain hashes against the CANVAS resolution, not the
        // (renderScale-shrunk) target — dynamicRes no longer chunks the film
        outResolution: { value: new THREE.Vector2(1, 1) },
        // §18.94: the half-res DOF field + a flag; the composite mixes it in
        // by CoC instead of gathering at full res.
        tDof: { value: null },
        dofHalf: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec2 vUv;
        uniform sampler2D tDiffuse;
        uniform sampler2D tDepth;
        uniform sampler2D tBloom;
        uniform sampler2D tDof;
        uniform vec2 resolution;
        uniform vec2 outResolution;
        uniform float camNear, camFar, focusDist, aperture, maxBlur, dofOn, sharpRange, dofHalf;
        uniform float grainAmount, vignette, caAmount, time, bloomStrength;

        float viewZ(vec2 uv) {
          float d = texture2D(tDepth, uv).x;
          // perspective depth -> positive view-space distance
          float zN = d * 2.0 - 1.0;
          return (2.0 * camNear * camFar) / (camFar + camNear - zN * (camFar - camNear));
        }

        float cocAt(vec2 uv) {
          float z = viewZ(uv);
          // circle of confusion in pixels: focus error over distance,
          // scaled by aperture; near-side blurs slightly harder (lens truth).
          // sharpRange (§18.60) carves a DEAD ZONE around the focal plane:
          // everything within that many metres of focus stays perfectly
          // crisp, and the ramp starts beyond it — "only the distant walls
          // blur, not the whole room" (Austin's arena report).
          float err = z - focusDist;
          float side = err < 0.0 ? 1.35 : 1.0;
          float mag = max(abs(err) - sharpRange, 0.0);
          return clamp(mag / max(z, 0.05) * aperture * side * resolution.y * 0.1,
                       0.0, maxBlur);
        }

        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }

        void main() {
          vec2 px = 1.0 / resolution;
          vec2 centered = vUv - 0.5;
          float r2 = dot(centered, centered);

          // -- chromatic aberration: radial RGB split, quadratic falloff --- //
          // §18.94: CA now rides the SHARP sample ALWAYS — it and DOF used to
          // be mutually exclusive (CA vanished on any blurred pixel). The
          // 12-tap gather moved to the half-res DOF pass; here we just mix
          // its upsampled result in by CoC — cheap (one depth fetch).
          vec2 caOff = centered * r2 * caAmount * 0.06;
          vec3 col = vec3(
            texture2D(tDiffuse, vUv - caOff).r,
            texture2D(tDiffuse, vUv).g,
            texture2D(tDiffuse, vUv + caOff).b);
          if (dofHalf > 0.5) {
            float coc = cocAt(vUv);
            if (coc > 0.5) {
              vec3 blur = texture2D(tDof, vUv).rgb; // bilinear upsample
              col = mix(col, blur, clamp((coc - 0.5) / 1.5, 0.0, 1.0));
            }
          }

          // -- bloom: the glow the bright-pass extracted ------------------- //
          if (bloomStrength > 0.0) {
            col += texture2D(tBloom, vUv).rgb * bloomStrength;
          }

          // -- film grain: animated, gentler in highlights ----------------- //
          float g = hash(vUv * outResolution + fract(time * 61.7) * 1e3) - 0.5;
          float luma = dot(col, vec3(0.299, 0.587, 0.114));
          col += g * grainAmount * (0.35 + 0.65 * (1.0 - luma)) * 0.35;

          // -- vignette ----------------------------------------------------- //
          col *= 1.0 - vignette * smoothstep(0.15, 0.75, r2);

          gl_FragColor = vec4(col, 1.0);
          // §18.88 THE TONEMAPPING FIX: three forces NoToneMapping +
          // linear output on render-target passes, so with PostFX live the
          // shipped frame NEVER saw AgX or the sRGB encode — raw linear
          // light to the canvas (FX_OFF looked like a different game; the
          // portal face carried a hand-rolled pow() workaround for the same
          // trap). These chunks are three's own: the renderer injects its
          // AgX define + toneMappingExposure because this material renders
          // to screen — bit-identical to the plain no-postfx path at last.
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(
      new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    quadMesh = new THREE.Mesh(geo, material);
    quadMesh.frustumCulled = false;
    quadScene = new THREE.Scene();
    quadScene.add(quadMesh);
  }

  return {
    /** Render `scene` through the uber-pass. `p` carries the PostFX
     *  element's live dat values + the smoothed focus distance. */
    render(scene, camera, p, dt) {
      const size = renderer.getDrawingBufferSize(_size);
      ensureQuad();
      // RENDER SCALE (§18.53): `(renderScale 0.75)` on the PostFX element
      // renders the 3D scene into a smaller target and lets the final
      // full-screen pass upscale it — ~1/scale² of the GPU fragment cost
      // back, with the film grain/CA/DOF hiding the softness. 1 = native.
      const rs = Math.min(1, Math.max(0.4, Number(p.renderScale) || 1));
      ensure(Math.round(size.x * rs), Math.round(size.y * rs));
      time += dt || 0.016;
      const u = material.uniforms;
      u.tDiffuse.value = target.texture;
      u.tDepth.value = target.depthTexture;
      u.camNear.value = camera.near;
      u.camFar.value = camera.far;
      u.focusDist.value = Math.max(0.2, Number(p.focusDist) || 4);
      u.aperture.value = Math.max(0, Number(p.dofAperture) || 0);
      u.maxBlur.value = Math.max(0, Number(p.dofMaxBlur) || 7);
      u.sharpRange.value = Math.max(0, Number(p.dofSharpRange) || 0);
      u.dofOn.value = p.dofEnabled === false || p.dofEnabled === 'false' ? 0 : 1;
      u.grainAmount.value = Math.max(0, Number(p.grainAmount) || 0);
      u.vignette.value = Math.max(0, Number(p.vignette) || 0);
      u.caAmount.value = Math.max(0, Number(p.caAmount) || 0);
      u.time.value = time;
      u.outResolution.value.set(size.x, size.y);
      const bloomS = Math.max(0, Number(p.bloomStrength) || 0);
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      // §18.94: the half-res DOF field — only when DOF is actually on and
      // has an aperture (a room-scale scene with everything in focus never
      // pays it). The composite mixes dofRT in by CoC.
      const dofActive = u.dofOn.value > 0.5 && u.aperture.value > 0;
      if (dofActive) {
        ensureDofMat();
        const du = dofMat.uniforms;
        du.tDiffuse.value = target.texture;
        du.tDepth.value = target.depthTexture;
        du.resolution.value.set(w, h); // FULL render res — see the shader note
        du.camNear.value = camera.near;
        du.camFar.value = camera.far;
        du.focusDist.value = u.focusDist.value;
        du.aperture.value = u.aperture.value;
        du.maxBlur.value = u.maxBlur.value;
        du.sharpRange.value = u.sharpRange.value;
        renderPass(dofMat, dofRT);
        u.tDof.value = dofRT.texture;
      }
      u.dofHalf.value = dofActive ? 1 : 0;
      if (bloomS > 0) {
        ensureBloomMats();
        brightMat.uniforms.tSrc.value = target.texture;
        brightMat.uniforms.threshold.value = Math.max(0, Number(p.bloomThreshold) || 0.75);
        renderPass(brightMat, brightRT);
        blurMat.uniforms.texel.value.set(1 / (w >> 2), 1 / (h >> 2));
        blurMat.uniforms.tSrc.value = brightRT.texture;
        blurMat.uniforms.dir.value.set(1, 0);
        renderPass(blurMat, blurA);
        blurMat.uniforms.tSrc.value = blurA.texture;
        blurMat.uniforms.dir.value.set(0, 1);
        renderPass(blurMat, blurB);
        blurMat.uniforms.tSrc.value = blurB.texture;
        blurMat.uniforms.dir.value.set(1, 0);
        renderPass(blurMat, blurA);
        blurMat.uniforms.tSrc.value = blurA.texture;
        blurMat.uniforms.dir.value.set(0, 1);
        renderPass(blurMat, blurB);
        u.tBloom.value = blurB.texture;
      }
      u.bloomStrength.value = bloomS;
      renderer.setRenderTarget(null);
      renderer.render(quadScene, quadCam);
    },

    dispose() {
      target?.depthTexture?.dispose();
      target?.dispose();
      brightRT?.dispose();
      blurA?.dispose();
      blurB?.dispose();
      dofRT?.dispose();
      brightMat?.dispose();
      blurMat?.dispose();
      dofMat?.dispose();
      material?.dispose();
      quadMesh?.geometry?.dispose();
      target = brightRT = blurA = blurB = dofRT = brightMat = blurMat = dofMat = null;
      quadScene = null;
    },
  };
}
