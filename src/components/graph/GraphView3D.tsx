"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type {
  Document,
  GraphModel,
  GraphNode,
  SessionViewState,
} from "@/core/types";
import {
  clusterColor,
  clusterIndexMap,
  getGraphTheme,
  type GraphStyleKey,
} from "@/core/graph/palette";
import { isCoreNode, nodeSize } from "@/core/graph/geometry";
import GraphLegend from "./GraphLegend";
import GraphToolbar from "./GraphToolbar";
import GraphTooltip, { type TooltipState } from "./GraphTooltip";

export interface GraphView3DProps {
  graph: GraphModel;
  selectedId?: string;
  onSelect: (node: GraphNode | null) => void;
  showDocuments: boolean;
  graphStyle?: GraphStyleKey;
  onStyleChange?: (style: GraphStyleKey) => void;
  initialView?: SessionViewState;
  onViewChange?: (view: SessionViewState) => void;
  documents?: Document[];
  onOpenDocument?: (doc: Document) => void;
  dimensionMode?: "2d" | "3d";
  onToggleDimension?: () => void;
}

interface NodeData3D {
  id: string;
  label: string;
  kind: string;
  weight: number;
  clusterId: string;
  color: string;
  size: number;
  isCore: boolean;
  publishedYear?: number;
  isYearInferred?: boolean;
  // 3D 物理空间坐标与动力学速度
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  mesh?: THREE.Object3D;
  labelSprite?: THREE.Sprite;
  glowMesh?: THREE.Mesh;
}

interface EdgeData3D {
  id: string;
  source: string;
  target: string;
  kind: string;
  weight: number;
  label: string;
}

// 缓存生成的发光纹理与文字贴图，避免重复分配显存
function createHaloTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2,
  );
  grad.addColorStop(0, "rgba(255, 255, 255, 1)");
  grad.addColorStop(0.25, "rgba(255, 255, 255, 0.65)");
  grad.addColorStop(0.6, "rgba(255, 255, 255, 0.2)");
  grad.addColorStop(1, "rgba(255, 255, 255, 0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

// 创建文字 Billboard 贴图
function createTextSprite(
  text: string,
  isCore: boolean,
  textColor: string,
  bgColor: string,
): THREE.Sprite {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  const fontSize = isCore ? 26 : 20;
  const paddingX = 14;
  const paddingY = 8;
  ctx.font = `${isCore ? "600" : "500"} ${fontSize}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;

  const metrics = ctx.measureText(text);
  const textWidth = Math.ceil(metrics.width);
  const w = textWidth + paddingX * 2;
  const h = fontSize + paddingY * 2;

  canvas.width = Math.max(32, w);
  canvas.height = Math.max(32, h);

  // 重新设置上下文状态
  ctx.font = `${isCore ? "600" : "500"} ${fontSize}px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";

  // 柔和的胶囊形半透明背景，防止连线穿插破坏文字可读性
  ctx.fillStyle = "rgba(13, 17, 23, 0.72)";
  ctx.beginPath();
  ctx.roundRect(2, 2, canvas.width - 4, canvas.height - 4, 8);
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
  ctx.lineWidth = 1;
  ctx.stroke();

  // 绘制文字
  ctx.fillStyle = textColor;
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    opacity: 0.95,
  });

  const sprite = new THREE.Sprite(material);
  // 等比放大保持清晰度
  const aspect = canvas.width / canvas.height;
  const baseScale = isCore ? 14 : 10;
  sprite.scale.set(baseScale * aspect, baseScale, 1);
  return sprite;
}

export default function GraphView3D({
  graph,
  selectedId,
  onSelect,
  showDocuments,
  graphStyle = "default",
  onStyleChange,
  initialView,
  onViewChange,
  documents = [],
  onOpenDocument,
  dimensionMode = "3d",
  onToggleDimension,
}: GraphView3DProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasContainerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);

  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [focusedClusterId, setFocusedClusterId] = useState<string | null>(null);
  const pinnedRef = useRef<Set<string>>(new Set());
  const [pinnedCount, setPinnedCount] = useState(0);

  const theme = useMemo(() => getGraphTheme(graphStyle), [graphStyle]);

  // 力导向衰减状态
  const simRef = useRef({ alpha: 1, running: true });
  const animFrameId = useRef<number | null>(null);

  // 3D 节点与连线数据
  const { nodes3D, edges3D, nodeMap } = useMemo(() => {
    const clusterIndex = clusterIndexMap(graph.clusters);
    const maxWeight = Math.max(1, ...graph.nodes.map((n) => n.weight));

    const visibleNodes = graph.nodes.filter(
      (n) => showDocuments || n.kind !== "document",
    );
    const visibleIdSet = new Set(visibleNodes.map((n) => n.id));

    // 为每个簇分配空间极坐标初始偏置，形成自然星系簇云
    const clusterAngles = new Map<string, { theta: number; phi: number }>();
    const clusterList = graph.clusters;
    clusterList.forEach((c, idx) => {
      const theta = (idx / Math.max(1, clusterList.length)) * Math.PI * 2;
      const phi = ((idx % 3) - 1) * 0.45;
      clusterAngles.set(c.id, { theta, phi });
    });

    const nMap = new Map<string, NodeData3D>();

    const nList: NodeData3D[] = visibleNodes.map((n, i) => {
      const size = nodeSize(n.weight, maxWeight, n.kind);
      const isCore = isCoreNode(size, n.kind);
      const cAngle = clusterAngles.get(n.clusterId) ?? {
        theta: (i * 0.7) % (Math.PI * 2),
        phi: 0,
      };

      const clusterDist = n.kind === "document" ? 320 : 200;
      const spread = 90;
      const cx = Math.cos(cAngle.theta) * Math.cos(cAngle.phi) * clusterDist;
      const cy = Math.sin(cAngle.phi) * clusterDist;
      const cz = Math.sin(cAngle.theta) * Math.cos(cAngle.phi) * clusterDist;

      const seedX = Math.sin(i * 12.9898) * 0.5 * spread;
      const seedY = Math.cos(i * 78.233) * 0.5 * spread;
      const seedZ = Math.sin(i * 43.123) * 0.5 * spread;

      const node3d: NodeData3D = {
        id: n.id,
        label: n.label,
        kind: n.kind,
        weight: n.weight,
        clusterId: n.clusterId,
        color:
          n.kind === "document"
            ? theme.docBorder
            : clusterColor(clusterIndex.get(n.clusterId) ?? 0, graphStyle),
        size,
        isCore,
        publishedYear: n.publishedYear,
        isYearInferred: n.isYearInferred,
        x: cx + seedX,
        y: cy + seedY,
        z: cz + seedZ,
        vx: 0,
        vy: 0,
        vz: 0,
      };
      nMap.set(n.id, node3d);
      return node3d;
    });

    const eList: EdgeData3D[] = graph.edges
      .filter((e) => visibleIdSet.has(e.source) && visibleIdSet.has(e.target))
      .map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        kind: e.kind,
        weight: e.weight,
        label: e.label ?? "",
      }));

    return { nodes3D: nList, edges3D: eList, nodeMap: nMap };
  }, [graph, showDocuments, graphStyle, theme]);

  // 共享几何体和通用材质缓存
  const sphereGeoMap = useRef<Map<number, THREE.SphereGeometry>>(new Map());
  const docGeo = useRef<THREE.SphereGeometry | null>(null);
  const docRingGeo = useRef<THREE.RingGeometry | null>(null);
  const haloTexture = useRef<THREE.Texture | null>(null);

  // 连线几何体引用，每帧更新顶点位置
  const edgeLinesRef = useRef<{
    lineSegments: LineSegments2;
    geometry: LineSegmentsGeometry;
    material: LineMaterial;
    positions: Float32Array;
    colors: Float32Array;
  } | null>(null);

  // 节点 Mesh 映射与光子粒子系统
  const nodeMeshMap = useRef<Map<string, THREE.Object3D>>(new Map());
  const photonsRef = useRef<
    { edgeIdx: number; progress: number; speed: number }[]
  >([]);

  // 构建与初始化 Three.js 场景
  useEffect(() => {
    const container = canvasContainerRef.current;
    if (!container) return;

    const width = container.clientWidth || 800;
    const height = container.clientHeight || 600;

    // 1. 场景
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(theme.canvasBg);
    sceneRef.current = scene;

    // 2. 相机
    const camera = new THREE.PerspectiveCamera(50, width / height, 1, 4000);
    camera.position.set(0, 180, 580);
    cameraRef.current = camera;

    // 3. 渲染器
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
      preserveDrawingBuffer: true,
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.innerHTML = "";
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // 4. OrbitControls 平滑轨道漫游
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.rotateSpeed = 0.85;
    controls.zoomSpeed = 1.1;
    controls.panSpeed = 0.8;
    controls.minDistance = 60;
    controls.maxDistance = 2200;
    controlsRef.current = controls;

    // 5. 光照系统
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.9);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.4);
    dirLight.position.set(200, 400, 300);
    scene.add(dirLight);

    const backLight = new THREE.DirectionalLight(0x70b5ff, 0.6);
    backLight.position.set(-200, -200, -300);
    scene.add(backLight);

    // 6. 深空粒子星云背景 (Starfield)
    const starCount = 600;
    const starGeo = new THREE.BufferGeometry();
    const starPos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const r = 900 + Math.random() * 900;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 2 - 1);
      starPos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      starPos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      starPos[i * 3 + 2] = r * Math.cos(phi);
    }
    starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
    const starMat = new THREE.PointsMaterial({
      color: 0x8b949e,
      size: 2.2,
      transparent: true,
      opacity: 0.45,
      depthTest: false,
    });
    const starField = new THREE.Points(starGeo, starMat);
    scene.add(starField);

    // 7. 共享资源初始化
    if (!haloTexture.current) {
      haloTexture.current = createHaloTexture();
    }
    if (!docGeo.current) {
      // 文档节点用精致 3D 微珠，彻底告别方形盒子
      docGeo.current = new THREE.SphereGeometry(4.8, 18, 18);
    }
    if (!docRingGeo.current) {
      // 文档节点外圈优雅的同心微型光环
      docRingGeo.current = new THREE.RingGeometry(6.0, 7.2, 24);
    }

    // 8. 节点 Object3D 组构建
    const nodeGroup = new THREE.Group();
    scene.add(nodeGroup);
    nodeMeshMap.current.clear();

    nodes3D.forEach((n) => {
      const isDoc = n.kind === "document";
      let mesh: THREE.Object3D;

      if (isDoc) {
        // 文档节点：发光微型水晶球 + 同心光晕外环，精致典雅，彻底消除“小黑框/方盒子”
        const mat = new THREE.MeshStandardMaterial({
          color: new THREE.Color(theme.docFill),
          emissive: new THREE.Color(theme.docBorder),
          emissiveIntensity: 0.45,
          roughness: 0.25,
          metalness: 0.2,
          transparent: true,
          opacity: 0.95,
        });
        const docSphere = new THREE.Mesh(docGeo.current!, mat);

        const ringMat = new THREE.MeshBasicMaterial({
          color: new THREE.Color(theme.docBorder),
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.85,
        });
        const docRing = new THREE.Mesh(docRingGeo.current!, ringMat);
        docRing.rotation.x = Math.PI / 3; // 稍作倾斜呈现星环般的质感

        const docGroup = new THREE.Group();
        docGroup.add(docSphere);
        docGroup.add(docRing);
        mesh = docGroup;
      } else {
        // 概念节点：发光球体
        const r = Math.max(3.5, n.size * 0.42);
        let geo = sphereGeoMap.current.get(r);
        if (!geo) {
          geo = new THREE.SphereGeometry(r, 24, 24);
          sphereGeoMap.current.set(r, geo);
        }

        const colorObj = new THREE.Color(n.color);
        const mat = new THREE.MeshStandardMaterial({
          color: colorObj,
          emissive: colorObj,
          emissiveIntensity: n.isCore ? 0.45 : 0.25,
          roughness: 0.25,
          metalness: 0.15,
        });
        mesh = new THREE.Mesh(geo, mat);

        // 核心大节点添加外层能量呼吸光晕 (Outer Glow Halo)
        if (n.isCore) {
          const haloGeo = new THREE.PlaneGeometry(r * 3.8, r * 3.8);
          const haloMat = new THREE.MeshBasicMaterial({
            map: haloTexture.current!,
            color: colorObj,
            transparent: true,
            opacity: 0.55,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
          });
          const halo = new THREE.Mesh(haloGeo, haloMat);
          halo.name = "glowHalo";
          mesh.add(halo);
          n.glowMesh = halo;
        }

        // 添加 Billboard 文字标签
        const labelSprite = createTextSprite(
          n.label,
          n.isCore,
          theme.nodeLabelColor,
          theme.canvasBg,
        );
        labelSprite.position.set(0, r + 7, 0);
        mesh.add(labelSprite);
        n.labelSprite = labelSprite;
      }

      mesh.position.set(n.x, n.y, n.z);
      (mesh as any).nodeId = n.id;
      n.mesh = mesh;
      nodeGroup.add(mesh);
      nodeMeshMap.current.set(n.id, mesh);
    });

    // 9. 连线 LineSegments2 / LineMaterial 粗连线批量渲染
    const edgeCount = edges3D.length;
    const posArray = new Float32Array(edgeCount * 2 * 3);
    const colorArray = new Float32Array(edgeCount * 2 * 3);

    const lineGeo = new LineSegmentsGeometry();
    lineGeo.setPositions(posArray);
    lineGeo.setColors(colorArray);

    const lineMat = new LineMaterial({
      vertexColors: true,
      transparent: true,
      opacity: Math.min(1.0, theme.edgeOpacity * 1.35),
      linewidth: 2.2, // 屏幕空间像素宽度，彻底解决连线过细看不清的问题
      resolution: new THREE.Vector2(width, height),
      depthWrite: false,
      blending: THREE.NormalBlending,
    });

    const edgeLines = new LineSegments2(lineGeo, lineMat);
    scene.add(edgeLines);
    edgeLinesRef.current = {
      lineSegments: edgeLines,
      geometry: lineGeo,
      material: lineMat,
      positions: posArray,
      colors: colorArray,
    };

    // 10. 初始化流动光子粒子系统 (Photon Energy Flow)
    const photonCount = Math.min(80, Math.max(20, edges3D.length));
    const photons: { edgeIdx: number; progress: number; speed: number }[] = [];
    for (let i = 0; i < photonCount; i++) {
      photons.push({
        edgeIdx: Math.floor(Math.random() * edges3D.length),
        progress: Math.random(),
        speed: 0.004 + Math.random() * 0.006,
      });
    }
    photonsRef.current = photons;

    const photonGeo = new THREE.BufferGeometry();
    const photonPositions = new Float32Array(photonCount * 3);
    photonGeo.setAttribute(
      "position",
      new THREE.BufferAttribute(photonPositions, 3),
    );
    const photonMat = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 4.5,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const photonPoints = new THREE.Points(photonGeo, photonMat);
    scene.add(photonPoints);

    // 11. 窗口自适应
    const handleResize = () => {
      if (!container || !rendererRef.current || !cameraRef.current) return;
      const w = container.clientWidth || 800;
      const h = container.clientHeight || 600;
      cameraRef.current.aspect = w / h;
      cameraRef.current.updateProjectionMatrix();
      rendererRef.current.setSize(w, h);
      if (edgeLinesRef.current?.material) {
        edgeLinesRef.current.material.resolution.set(w, h);
      }
    };
    window.addEventListener("resize", handleResize);

    // 12. 动画渲染与力导向物理循环
    simRef.current = { alpha: 1, running: true };

    const animate = () => {
      animFrameId.current = requestAnimationFrame(animate);

      // --- 物理模拟计算步进 ---
      const sim = simRef.current;
      if (sim.running && sim.alpha >= 0.005) {
        const alpha = sim.alpha;
        const count = nodes3D.length;

        // 斥力
        for (let i = 0; i < count; i++) {
          const a = nodes3D[i];
          for (let j = i + 1; j < count; j++) {
            const b = nodes3D[j];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const dz = b.z - a.z;
            const distSq = dx * dx + dy * dy + dz * dz + 40;
            const dist = Math.sqrt(distSq);
            if (dist > 450) continue;

            const strength = (8000 / distSq) * alpha;
            const fx = (dx / dist) * strength;
            const fy = (dy / dist) * strength;
            const fz = (dz / dist) * strength;

            a.vx -= fx;
            a.vy -= fy;
            a.vz -= fz;
            b.vx += fx;
            b.vy += fy;
            b.vz += fz;
          }
        }

        // 弹簧引力
        for (let i = 0; i < edges3D.length; i++) {
          const e = edges3D[i];
          const a = nodeMap.get(e.source);
          const b = nodeMap.get(e.target);
          if (!a || !b) continue;

          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dz = b.z - a.z;
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
          const idealDist = e.kind === "contains" ? 70 : 110;
          const force = (dist - idealDist) * 0.045 * alpha;

          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          const fz = (dz / dist) * force;

          a.vx += fx;
          a.vy += fy;
          a.vz += fz;
          b.vx -= fx;
          b.vy -= fy;
          b.vz -= fz;
        }

        // 向心力与阻尼
        for (let i = 0; i < count; i++) {
          const n = nodes3D[i];
          if (pinnedRef.current.has(n.id)) {
            n.vx = 0;
            n.vy = 0;
            n.vz = 0;
            continue;
          }
          n.vx -= n.x * 0.0035 * alpha;
          n.vy -= n.y * 0.0035 * alpha;
          n.vz -= n.z * 0.0035 * alpha;

          n.vx *= 0.82;
          n.vy *= 0.82;
          n.vz *= 0.82;

          n.x += n.vx;
          n.y += n.vy;
          n.z += n.vz;

          if (n.mesh) {
            n.mesh.position.set(n.x, n.y, n.z);
          }
        }

        sim.alpha *= 0.985;
      }

      // --- 同步连线顶点坐标与颜色 ---
      if (edgeLinesRef.current) {
        const { positions, colors, geometry } = edgeLinesRef.current;
        const defaultEdgeColor = new THREE.Color(theme.edgeColor);
        const defaultContainsColor = new THREE.Color(theme.edgeContainsColor);

        for (let i = 0; i < edges3D.length; i++) {
          const e = edges3D[i];
          const a = nodeMap.get(e.source);
          const b = nodeMap.get(e.target);
          if (!a || !b) continue;

          const idx = i * 6;
          positions[idx] = a.x;
          positions[idx + 1] = a.y;
          positions[idx + 2] = a.z;
          positions[idx + 3] = b.x;
          positions[idx + 4] = b.y;
          positions[idx + 5] = b.z;

          // 连线色
          const col =
            e.kind === "contains" ? defaultContainsColor : defaultEdgeColor;
          colors[idx] = col.r;
          colors[idx + 1] = col.g;
          colors[idx + 2] = col.b;
          colors[idx + 3] = col.r;
          colors[idx + 4] = col.g;
          colors[idx + 5] = col.b;
        }

        geometry.setPositions(positions);
        geometry.setColors(colors);
      }

      // --- 更新能量光子流动 ---
      if (photons.length > 0 && edges3D.length > 0) {
        const pPositions = photonPoints.geometry.attributes.position
          .array as Float32Array;
        for (let i = 0; i < photons.length; i++) {
          const p = photons[i];
          p.progress += p.speed;
          if (p.progress >= 1) {
            p.progress = 0;
            p.edgeIdx = Math.floor(Math.random() * edges3D.length);
          }
          const e = edges3D[p.edgeIdx];
          const a = nodeMap.get(e.source);
          const b = nodeMap.get(e.target);
          if (a && b) {
            pPositions[i * 3] = a.x + (b.x - a.x) * p.progress;
            pPositions[i * 3 + 1] = a.y + (b.y - a.y) * p.progress;
            pPositions[i * 3 + 2] = a.z + (b.z - a.z) * p.progress;
          }
        }
        photonPoints.geometry.attributes.position.needsUpdate = true;
      }

      // --- 让发光 Halo 始终面向相机 ---
      if (cameraRef.current) {
        nodes3D.forEach((n) => {
          if (n.glowMesh) {
            n.glowMesh.quaternion.copy(cameraRef.current!.quaternion);
          }
        });
      }

      // OrbitControls 阻尼更新与渲染
      controls.update();
      renderer.render(scene, camera);
    };

    animate();

    return () => {
      window.removeEventListener("resize", handleResize);
      if (animFrameId.current) cancelAnimationFrame(animFrameId.current);
      if (edgeLinesRef.current) {
        edgeLinesRef.current.geometry.dispose();
        edgeLinesRef.current.material.dispose();
      }
      controls.dispose();
      renderer.dispose();
      container.innerHTML = "";
    };
  }, [nodes3D, edges3D, nodeMap, theme]);

  // 高亮与簇聚焦 (Focus / Selection / Hover 材质状态更新)
  useEffect(() => {
    nodes3D.forEach((n) => {
      if (!n.mesh) return;

      const isDoc = n.kind === "document";
      const isSelected = selectedId === n.id;
      const isHovered = hoveredNode?.id === n.id;
      const inFocusedCluster =
        !focusedClusterId || n.clusterId === focusedClusterId;

      const targetScale = isSelected ? 1.4 : isHovered ? 1.25 : 1.0;
      n.mesh.scale.set(targetScale, targetScale, targetScale);

      if (isDoc) {
        // 文档微珠与光环
        const group = n.mesh as THREE.Group;
        const sphereMesh = group.children[0] as THREE.Mesh;
        const ringMesh = group.children[1] as THREE.Mesh;
        const sphereMat = sphereMesh?.material as THREE.MeshStandardMaterial;
        const ringMat = ringMesh?.material as THREE.MeshBasicMaterial;
        if (sphereMat) {
          sphereMat.opacity = inFocusedCluster ? 0.95 : 0.15;
          sphereMat.emissiveIntensity = isHovered || isSelected ? 0.85 : 0.45;
        }
        if (ringMat) {
          ringMat.opacity = inFocusedCluster ? 0.85 : 0.1;
        }
      } else {
        // 概念球体
        const mesh = n.mesh as THREE.Mesh;
        const mat = mesh.material as THREE.MeshStandardMaterial;
        if (mat) {
          mat.emissiveIntensity =
            isSelected || isHovered ? 0.85 : n.isCore ? 0.45 : 0.25;
        }
        if (n.labelSprite) {
          n.labelSprite.material.opacity = inFocusedCluster ? 0.95 : 0.1;
        }
      }
    });
  }, [nodes3D, selectedId, hoveredNode, focusedClusterId]);

  // Raycaster 交互检测（悬停 Tooltip、点击选中、双击打开文档）
  useEffect(() => {
    const container = canvasContainerRef.current;
    if (!container) return;

    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    let mouseDownPos = { x: 0, y: 0 };

    const getIntersectNode = (e: MouseEvent): GraphNode | null => {
      if (!rendererRef.current || !cameraRef.current) return null;
      const rect = container.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, cameraRef.current);
      const interactiveObjects: THREE.Object3D[] = [];
      nodeMeshMap.current.forEach((mesh) => interactiveObjects.push(mesh));

      const intersects = raycaster.intersectObjects(interactiveObjects, true);
      if (intersects.length > 0) {
        let hitObj: THREE.Object3D | null = intersects[0].object;
        while (hitObj && !(hitObj as any).nodeId && hitObj.parent) {
          hitObj = hitObj.parent;
        }
        const hitId = (hitObj as any)?.nodeId;
        if (hitId) {
          return graph.nodes.find((n) => n.id === hitId) ?? null;
        }
      }
      return null;
    };

    const handlePointerDown = (e: MouseEvent) => {
      mouseDownPos = { x: e.clientX, y: e.clientY };
    };

    const handlePointerUp = (e: MouseEvent) => {
      const dx = Math.abs(e.clientX - mouseDownPos.x);
      const dy = Math.abs(e.clientY - mouseDownPos.y);
      // 微小位移视为点击
      if (dx < 5 && dy < 5) {
        const hit = getIntersectNode(e);
        if (hit) {
          onSelect(hit);
        } else {
          onSelect(null);
          setFocusedClusterId(null);
        }
      }
    };

    const handlePointerMove = (e: MouseEvent) => {
      const hit = getIntersectNode(e);
      if (hit) {
        setHoveredNode(hit);
        const rect = container.getBoundingClientRect();
        setTooltip({
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
          node: hit,
        });
        container.style.cursor = "pointer";
      } else {
        setHoveredNode(null);
        setTooltip(null);
        container.style.cursor = "default";
      }
    };

    const handleDblClick = (e: MouseEvent) => {
      const hit = getIntersectNode(e);
      if (hit && hit.kind === "document" && onOpenDocument) {
        const doc = documents.find((d) => d.id === hit.id);
        if (doc) onOpenDocument(doc);
      }
    };

    container.addEventListener("mousedown", handlePointerDown);
    container.addEventListener("mouseup", handlePointerUp);
    container.addEventListener("mousemove", handlePointerMove);
    container.addEventListener("dblclick", handleDblClick);

    return () => {
      container.removeEventListener("mousedown", handlePointerDown);
      container.removeEventListener("mouseup", handlePointerUp);
      container.removeEventListener("mousemove", handlePointerMove);
      container.removeEventListener("dblclick", handleDblClick);
    };
  }, [graph.nodes, onSelect, onOpenDocument, documents]);

  // 工具栏功能回调
  const handleRelayout = useCallback(() => {
    simRef.current = { alpha: 1, running: true };
  }, []);

  const handleFit = useCallback(() => {
    if (!controlsRef.current || !cameraRef.current) return;
    cameraRef.current.position.set(0, 180, 580);
    controlsRef.current.target.set(0, 0, 0);
    controlsRef.current.update();
  }, []);

  const handlePinSelected = useCallback(() => {
    if (!selectedId) return;
    pinnedRef.current.add(selectedId);
    setPinnedCount(pinnedRef.current.size);
  }, [selectedId]);

  const handleUnpinAll = useCallback(() => {
    pinnedRef.current.clear();
    setPinnedCount(0);
  }, []);

  const handleExportPng = useCallback(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const url = renderer.domElement.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = url;
    a.download = `topology-3d-three-${Date.now()}.png`;
    a.click();
  }, []);

  const handleToggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      void el
        .requestFullscreen()
        .then(() => setFullscreen(true))
        .catch(() => {});
    } else {
      void document
        .exitFullscreen()
        .then(() => setFullscreen(false))
        .catch(() => {});
    }
  }, []);

  return (
    <div
      ref={containerRef}
      className={`graph-view-wrap${fullscreen ? " fullscreen" : ""}`}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        overflow: "hidden",
      }}
    >
      <div
        ref={canvasContainerRef}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          overflow: "hidden",
        }}
      />

      <GraphToolbar
        onRelayout={handleRelayout}
        onFit={handleFit}
        onPinSelected={handlePinSelected}
        onUnpinAll={handleUnpinAll}
        onExportPng={handleExportPng}
        onFullscreen={handleToggleFullscreen}
        dimensionMode={dimensionMode}
        onToggleDimension={onToggleDimension}
        graphStyle={graphStyle}
        onStyleChange={onStyleChange}
        selectedCount={selectedId ? 1 : 0}
        pinnedCount={pinnedCount}
        fullscreen={fullscreen}
      />

      {tooltip && <GraphTooltip state={tooltip} />}

      <GraphLegend
        clusters={graph.clusters}
        onFocus={(c) =>
          setFocusedClusterId((prev) => (prev === c.id ? null : c.id))
        }
        activeId={focusedClusterId}
        graphStyle={graphStyle}
      />
    </div>
  );
}
