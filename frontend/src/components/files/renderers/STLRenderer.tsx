import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { STLLoader } from 'three/addons/loaders/STLLoader.js'

interface STLRendererProps {
  url: string
}

export function STLRenderer({ url }: STLRendererProps) {
  const mountRef = useRef<HTMLDivElement>(null)
  // Hold references to GPU resources so the cleanup function can dispose them
  // even when they were created inside the async STLLoader callback.
  const geometryRef = useRef<THREE.BufferGeometry | null>(null)
  const materialRef = useRef<THREE.MeshStandardMaterial | null>(null)

  useEffect(() => {
    const el = mountRef.current
    if (!el) return

    const width = el.clientWidth || 600
    const height = el.clientHeight || 400

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x1a1d27)

    const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 1000)
    camera.position.set(0, 0, 100)

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setSize(width, height)
    renderer.setPixelRatio(window.devicePixelRatio)
    el.appendChild(renderer.domElement)

    const ambient = new THREE.AmbientLight(0xffffff, 0.6)
    scene.add(ambient)
    const dirLight = new THREE.DirectionalLight(0xffffff, 1)
    dirLight.position.set(1, 2, 3)
    scene.add(dirLight)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true

    const loader = new STLLoader()
    let active = true // guard: discard callback results after cleanup
    loader.load(url, geometry => {
      if (!active) {
        geometry.dispose() // unmounted before load finished — free immediately
        return
      }
      geometryRef.current = geometry
      geometry.computeBoundingSphere()
      geometry.center()
      const radius = geometry.boundingSphere?.radius ?? 50
      camera.position.set(0, 0, radius * 2.5)
      camera.near = radius * 0.01
      camera.far = radius * 10
      camera.updateProjectionMatrix()
      controls.update()

      const material = new THREE.MeshStandardMaterial({ color: 0x7eb3f5 })
      materialRef.current = material
      const mesh = new THREE.Mesh(geometry, material)
      scene.add(mesh)
    })

    let animId: number
    const animate = () => {
      animId = requestAnimationFrame(animate)
      controls.update()
      renderer.render(scene, camera)
    }
    animate()

    const ro = new ResizeObserver(() => {
      const w = el.clientWidth
      const h = el.clientHeight
      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    })
    ro.observe(el)

    return () => {
      active = false
      cancelAnimationFrame(animId)
      ro.disconnect()
      controls.dispose()
      // Dispose GPU-allocated geometry and material to prevent WebGL memory leaks.
      geometryRef.current?.dispose()
      materialRef.current?.dispose()
      geometryRef.current = null
      materialRef.current = null
      renderer.dispose()
      if (el.contains(renderer.domElement)) el.removeChild(renderer.domElement)
    }
  }, [url])

  return <div ref={mountRef} className="w-full h-full" />
}
