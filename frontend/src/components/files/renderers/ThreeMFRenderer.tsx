import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js'

interface ThreeMFRendererProps {
  url: string
}

export function ThreeMFRenderer({ url }: ThreeMFRendererProps) {
  const mountRef = useRef<HTMLDivElement>(null)
  const groupRef = useRef<THREE.Group | null>(null)

  useEffect(() => {
    const el = mountRef.current
    if (!el) return

    const width = el.clientWidth || 600
    const height = el.clientHeight || 400

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x1a1d27)

    const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 10000)
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
    const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.4)
    dirLight2.position.set(-1, -1, -2)
    scene.add(dirLight2)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true

    const loader = new ThreeMFLoader()
    let active = true
    loader.load(url, (group) => {
      if (!active) return
      groupRef.current = group

      // Apply a default material to meshes that don't have one with color
      group.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          if (!child.material || (child.material as THREE.Material).type === 'MeshPhongMaterial') {
            child.material = new THREE.MeshStandardMaterial({ color: 0x7eb3f5 })
          }
        }
      })

      // Center and scale the model
      const box = new THREE.Box3().setFromObject(group)
      const center = box.getCenter(new THREE.Vector3())
      const size = box.getSize(new THREE.Vector3())
      const maxDim = Math.max(size.x, size.y, size.z)

      group.position.sub(center)
      scene.add(group)

      const radius = maxDim / 2
      camera.position.set(0, 0, radius * 2.5)
      camera.near = radius * 0.01
      camera.far = radius * 10
      camera.updateProjectionMatrix()
      controls.update()
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
      // Dispose all meshes inside the group
      groupRef.current?.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry?.dispose()
          if (Array.isArray(child.material)) {
            child.material.forEach(m => m.dispose())
          } else {
            child.material?.dispose()
          }
        }
      })
      groupRef.current = null
      renderer.dispose()
      if (el.contains(renderer.domElement)) el.removeChild(renderer.domElement)
    }
  }, [url])

  return <div ref={mountRef} className="w-full h-full" />
}
