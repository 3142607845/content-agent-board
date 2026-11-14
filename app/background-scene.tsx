"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";

interface BackgroundSceneProps {
  /** 流水线运行中时粒子流速轻微加快、色调更亮，作为状态呼应 */
  active: boolean;
}

interface ParticleLayerOptions {
  count: number;
  size: number;
  opacity: number;
  color: number;
  zFrom: number;
  zSpan: number;
  /** 自转方向与速度，正负相反可让两层产生纵深错位 */
  spin: number;
}

/**
 * 全屏 3D 背景装饰：双层悬浮粒子 + 双层流动网格 + 缓慢旋转的线框几何体与轨道环。
 * 只做氛围，不接收交互；指针事件全部穿透，不影响上方卡片与按钮。
 * canvas 由 effect 内部创建，避免 React Strict Mode 二次挂载时复用已被占用的上下文。
 */
export default function BackgroundScene({ active }: BackgroundSceneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    host.appendChild(canvas);

    // 自己先取上下文，再交给 three，避免 three 内部按默认类型取到冲突的上下文
    const context =
      canvas.getContext("webgl2", {
        alpha: true,
        antialias: false,
        powerPreference: "low-power",
      }) ??
      canvas.getContext("webgl", {
        alpha: true,
        antialias: false,
        powerPreference: "low-power",
      });

    if (!context) {
      // 设备不支持 WebGL 时静默降级，页面其余部分照常可用
      host.removeChild(canvas);
      return;
    }

    const renderer = new THREE.WebGLRenderer({
      canvas,
      context,
      alpha: true,
      antialias: false,
    });

    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 90);
    camera.position.set(0, 1.2, 16);

    // 默认的 PointsMaterial 画的是方点，放大后会显脏；换成径向渐变的柔光圆点
    const particleTexture = (() => {
      const size = 64;
      const textureCanvas = document.createElement("canvas");
      textureCanvas.width = size;
      textureCanvas.height = size;
      const ctx = textureCanvas.getContext("2d");
      if (!ctx) return null;
      const gradient = ctx.createRadialGradient(
        size / 2,
        size / 2,
        0,
        size / 2,
        size / 2,
        size / 2,
      );
      gradient.addColorStop(0, "rgba(255, 255, 255, 1)");
      gradient.addColorStop(0.35, "rgba(255, 255, 255, 0.8)");
      gradient.addColorStop(1, "rgba(255, 255, 255, 0)");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, size, size);
      return new THREE.CanvasTexture(textureCanvas);
    })();

    // 小屏设备减半粒子数，避免低端机掉帧
    const density = window.innerWidth < 768 ? 0.55 : 1;

    function createParticleLayer(options: ParticleLayerOptions) {
      const positions = new Float32Array(options.count * 3);
      for (let i = 0; i < options.count; i += 1) {
        const side = Math.random() < 0.5 ? -1 : 1;
        // 幂函数把更多粒子推向画面两侧，让中间阅读区更干净
        positions[i * 3] = side * Math.pow(Math.random(), 0.62) * 24;
        positions[i * 3 + 1] = (Math.random() - 0.5) * 26;
        positions[i * 3 + 2] = options.zFrom + Math.random() * options.zSpan;
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(positions, 3),
      );
      const material = new THREE.PointsMaterial({
        color: options.color,
        size: options.size,
        map: particleTexture ?? undefined,
        alphaTest: 0.02,
        sizeAttenuation: true,
        transparent: true,
        opacity: options.opacity,
        depthWrite: false,
      });
      const points = new THREE.Points(geometry, material);
      scene.add(points);
      return {
        points,
        geometry,
        material,
        spin: options.spin,
        baseColor: new THREE.Color(options.color),
        activeColor: new THREE.Color(options.color).lerp(
          new THREE.Color(0x6d84d4),
          0.55,
        ),
      };
    }

    const particleLayers = [
      // 远景：数量多、颗粒小，负责铺满纵深
      createParticleLayer({
        count: Math.round(640 * density),
        size: 0.075,
        opacity: 0.5,
        color: 0x93a9c6,
        zFrom: -26,
        zSpan: 16,
        spin: 0.012,
      }),
      // 近景：数量少、颗粒大，离镜头近所以更实、更亮
      createParticleLayer({
        count: Math.round(190 * density),
        size: 0.17,
        opacity: 0.62,
        color: 0x8ea6c4,
        zFrom: -14,
        zSpan: 11,
        spin: -0.022,
      }),
    ];

    // 地面网格做两层：近层清晰、远层更淡，形成地平线纵深
    const nearGrid = new THREE.GridHelper(80, 46, 0xb7c6da, 0xd8e0ec);
    const nearGridMaterial = nearGrid.material as THREE.Material;
    nearGridMaterial.transparent = true;
    nearGridMaterial.opacity = 0.6;
    nearGrid.position.set(0, -7, -4);
    scene.add(nearGrid);

    const farGrid = new THREE.GridHelper(120, 60, 0xc8d4e4, 0xe2e8f1);
    const farGridMaterial = farGrid.material as THREE.Material;
    farGridMaterial.transparent = true;
    farGridMaterial.opacity = 0.32;
    farGrid.position.set(0, -9.4, -16);
    scene.add(farGrid);

    const wireMaterial = new THREE.MeshBasicMaterial({
      color: 0x9cb1cb,
      wireframe: true,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
    });

    const icosahedron = new THREE.Mesh(
      new THREE.IcosahedronGeometry(3.2, 1),
      wireMaterial,
    );
    icosahedron.position.set(-6.4, 2.4, -9);
    scene.add(icosahedron);

    const octahedron = new THREE.Mesh(
      new THREE.OctahedronGeometry(2.2, 0),
      wireMaterial.clone(),
    );
    octahedron.position.set(6.8, -1.4, -10);
    scene.add(octahedron);

    // 轨道环：给两块线框套一圈极细的环，增强"系统在运转"的科技感
    function createOrbit(radius: number, opacity: number, host: THREE.Vector3) {
      const geometry = new THREE.TorusGeometry(radius, 0.014, 6, 96);
      const material = new THREE.MeshBasicMaterial({
        color: 0xaabdd6,
        transparent: true,
        opacity,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.copy(host);
      scene.add(mesh);
      return { mesh, geometry, material };
    }

    const orbits = [
      createOrbit(5.2, 0.3, icosahedron.position),
      createOrbit(3.5, 0.22, octahedron.position),
    ];

    function resize() {
      const width = window.innerWidth;
      const height = window.innerHeight;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }
    resize();
    window.addEventListener("resize", resize);

    // 鼠标位置驱动轻微视差，只读坐标，不拦截任何事件
    const pointer = { x: 0, y: 0 };
    const parallax = { x: 0, y: 0 };
    function handlePointerMove(event: PointerEvent) {
      pointer.x = event.clientX / window.innerWidth - 0.5;
      pointer.y = event.clientY / window.innerHeight - 0.5;
    }
    window.addEventListener("pointermove", handlePointerMove, {
      passive: true,
    });

    let frameId = 0;
    let lastTime = performance.now();
    let speed = 1;
    const clockStart = performance.now();

    function renderFrame(now: number) {
      const delta = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;

      // 运行时加速到 1.8 倍，停止后平滑回落到 1 倍
      const targetSpeed = activeRef.current ? 1.8 : 1;
      speed += (targetSpeed - speed) * Math.min(1, delta * 2);
      const energy = THREE.MathUtils.clamp((speed - 1) / 0.8, 0, 1);

      const elapsed = (now - clockStart) / 1000;

      // 两层粒子反向自转，近层更快，制造纵深错位
      for (const layer of particleLayers) {
        layer.points.rotation.y = elapsed * layer.spin * speed;
        layer.points.rotation.z = Math.sin(elapsed * 0.05) * 0.03;
        layer.material.color
          .copy(layer.baseColor)
          .lerp(layer.activeColor, energy);
      }

      nearGrid.position.z = -4 + ((elapsed * 0.5 * speed) % 1.74);
      farGrid.position.z = -16 + ((elapsed * 0.26 * speed) % 2);

      icosahedron.rotation.x = elapsed * 0.055 * speed;
      icosahedron.rotation.y = elapsed * 0.075 * speed;
      octahedron.rotation.y = -elapsed * 0.09 * speed;
      octahedron.rotation.z = elapsed * 0.04 * speed;

      const outerOrbit = orbits[0];
      const innerOrbit = orbits[1];
      outerOrbit.mesh.rotation.x =
        Math.PI / 2.5 + Math.sin(elapsed * 0.12) * 0.12;
      outerOrbit.mesh.rotation.y = 0.5 + elapsed * 0.05 * speed;
      innerOrbit.mesh.rotation.x =
        -Math.PI / 2.9 + Math.sin(elapsed * 0.16) * 0.1;
      innerOrbit.mesh.rotation.z = elapsed * 0.06 * speed;

      if (!reduceMotion) {
        // 相机跟随鼠标做很小的位移，再回看场景中心，产生旋转式视差
        parallax.x += (pointer.x * 1.8 - parallax.x) * Math.min(1, delta * 1.6);
        parallax.y += (-pointer.y * 1.1 - parallax.y) * Math.min(1, delta * 1.6);
        camera.position.x = parallax.x;
        camera.position.y = 1.2 + parallax.y;
        camera.lookAt(0, 0.4, -10);
      }

      renderer.render(scene, camera);
    }

    function loop(now: number) {
      renderFrame(now);
      frameId = window.requestAnimationFrame(loop);
    }

    if (reduceMotion) {
      // 用户偏好减少动效：只画一帧静态底图
      renderer.render(scene, camera);
    } else {
      frameId = window.requestAnimationFrame(loop);
    }

    function handleVisibility() {
      if (document.hidden) {
        window.cancelAnimationFrame(frameId);
        frameId = 0;
      } else if (!frameId && !reduceMotion) {
        lastTime = performance.now();
        frameId = window.requestAnimationFrame(loop);
      }
    }
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("visibilitychange", handleVisibility);
      for (const layer of particleLayers) {
        layer.geometry.dispose();
        layer.material.dispose();
      }
      particleTexture?.dispose();
      nearGrid.geometry.dispose();
      nearGridMaterial.dispose();
      farGrid.geometry.dispose();
      farGridMaterial.dispose();
      icosahedron.geometry.dispose();
      (icosahedron.material as THREE.Material).dispose();
      octahedron.geometry.dispose();
      (octahedron.material as THREE.Material).dispose();
      for (const orbit of orbits) {
        orbit.geometry.dispose();
        orbit.material.dispose();
      }
      renderer.dispose();
      context.getExtension("WEBGL_lose_context")?.loseContext();
      if (canvas.parentNode === host) host.removeChild(canvas);
    };
  }, []);

  return (
    <div
      ref={hostRef}
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10"
    />
  );
}
