//#region ragdoll's import
const SGIkHelper = require("../shared/IK/SGIkHelper")
const ObjectRotationControl = require("../shared/IK/objects/ObjectRotationControl")
const { isCustomModel } = require('../services/model-loader')
//#endregion
const THREE = require('three')
window.THREE = window.THREE || THREE

const React = require('react')
const { useRef, useEffect, useState } = React

const path = require('path')

const BonesHelper = require('./BonesHelper')
const IconSprites = require('./IconSprites')

const { initialState } = require('../shared/reducers/shot-generator')

const applyDeviceQuaternion = require('./apply-device-quaternion')

// character needs:
//   mesh - SkinnedMesh
//   bone structure - ideally Mixamo standard bones
//

require('../vendor/three/examples/js/loaders/GLTFLoader')
require('../vendor/three/examples/js/loaders/OBJLoader2')
const loadingManager = new THREE.LoadingManager()
const objLoader = new THREE.OBJLoader2(loadingManager)
const gltfLoader = new THREE.GLTFLoader(loadingManager)
objLoader.setLogging(false, false)
THREE.Cache.enabled = true

const isValidSkinnedMesh = data => {
  try {
    let mesh = data.scene.children.find(child => child instanceof THREE.SkinnedMesh) ||
              data.scene.children[0].children.find(child => child instanceof THREE.SkinnedMesh)
    return (mesh != null)
  } catch (err) {
    console.error(err)
    return false
  }
}

const cloneGltf = (gltf) => {
  const clone = {
    animations: gltf.animations || [],
    scene: gltf.scene.clone(true)
  };

  const skinnedMeshes = {};

  gltf.scene.traverse(node => {
    if (node.isSkinnedMesh) {
      skinnedMeshes[node.name] = node;
    }
  });

  const cloneBones = {};
  const cloneSkinnedMeshes = {};

  clone.scene.traverse(node => {
    if (node.isBone) {
      cloneBones[node.name] = node;
    }

    if (node.isSkinnedMesh) {
      cloneSkinnedMeshes[node.name] = node;
    }
  });

  for (let name in skinnedMeshes) {
    const skinnedMesh = skinnedMeshes[name];
    const skeleton = skinnedMesh.skeleton;
    const cloneSkinnedMesh = cloneSkinnedMeshes[name];

    const orderedCloneBones = [];

    for (let i = 0; i < skeleton.bones.length; ++i) {
      const cloneBone = cloneBones[skeleton.bones[i].name];
      orderedCloneBones.push(cloneBone);
    }

    cloneSkinnedMesh.bind(
        new THREE.Skeleton(orderedCloneBones, skeleton.boneInverses),
        cloneSkinnedMesh.matrixWorld);
  }

  return clone;
}

const characterFactory = data => {
  data = cloneGltf(data)

  //console.log('factory got data: ', data)
  let boneLengthScale = 1
  let material = new THREE.MeshToonMaterial({
    color: 0xffffff,
    emissive: 0x0,
    specular: 0x0,
    skinning: true,
    shininess: 0,
    flatShading: false,
    morphNormals: true,
    morphTargets: true
  })

  let mesh
  let skeleton
  let armatures
  let parentRotation = new THREE.Quaternion()
  let parentPosition = new THREE.Vector3()
  mesh = data.scene.children.find(child => child instanceof THREE.SkinnedMesh) ||
         data.scene.children[0].children.find(child => child instanceof THREE.SkinnedMesh)

  if (mesh == null) {
    mesh = new THREE.Mesh()
    skeleton = null
    armatures = null
    let originalHeight = 0

    return { mesh, skeleton, armatures, originalHeight, boneLengthScale, parentRotation, parentPosition }
  }

  armatures = data.scene.children[0].children.filter(child => child instanceof THREE.Bone)
  if (armatures.length === 0 ) {  // facebook export is different - bone structure is inside another object3D
    armatures = data.scene.children[0].children[0].children.filter(child => child instanceof THREE.Bone)

    if (armatures.length === 0) {  //specifically adult-female - bone structure is inside the skinned mesh
      armatures = mesh.children[0].children.filter(child => child instanceof THREE.Bone)
    }
    for (var bone of armatures)
    {
      bone.scale.set(1,1,1)
      bone.quaternion.multiply(data.scene.children[0].children[0].quaternion)
      bone.position.set(bone.position.x,bone.position.z,bone.position.y)
    }
    mesh.scale.set(1,1,1)
    parentRotation = data.scene.children[0].children[0].quaternion.clone()
    parentPosition = armatures[0].position.clone()
    boneLengthScale = 100
  }

  skeleton = mesh.skeleton

  if (mesh.material.map) {
    material.map = mesh.material.map
    material.map.needsUpdate = true
  }

  mesh.material = material
  mesh.renderOrder = 1.0

  let bbox = new THREE.Box3().setFromObject(mesh)
  let originalHeight = bbox.max.y - bbox.min.y

  return { mesh, skeleton, armatures, originalHeight, boneLengthScale, parentRotation, parentPosition }
}

const remap = (x, a, b, c, d) => (x - a) * (d - c) / (b - a) + c
const adjusted = value => remap(value, -16385, 16384, -Math.PI, Math.PI)

const Character = React.memo(({
  scene,
  id,
  type,
  remoteInput,
  isSelected,
  selectedBone,
  camera,
  updateCharacterSkeleton,
  updateCharacterIkSkeleton,
  updateObject,
  devices,
  icon,
  storyboarderFilePath,
  boardUid,

  loaded,
  modelData,
  largeRenderer,
  deleteObjects,
  updateObjects,
  defaultPosePreset,
  ...props
}) => {
  const [ready, setReady] = useState(false) // ready to load?
  // setting loaded = true forces an update to sceneObjects,
  // which is what Editor listens for to attach the BonesHelper
  const setLoaded = loaded => updateObject(id, { loaded })
  const object = useRef(null)
  const [attachables, setAttachables] = useState(null)
  const [modelChanged, setModelChange] = useState(false)
  const originalSkeleton = useRef(null)
  let objectRotationControl = useRef(null)

  const doCleanup = () => {
    if (object.current) {
      console.log(type, id, 'remove')
      scene.remove(object.current.bonesHelper)
      scene.remove(object.current.orthoIcon)
      scene.remove(object.current)
      object.current.userData.id === null
      object.current.remove(SGIkHelper.getInstance())
      SGIkHelper.getInstance().deselectControlPoint()
      SGIkHelper.getInstance().removeFromParent(id)
      objectRotationControl.current.deselectObject()
      object.current.bonesHelper = null
      scene.remove(object.current)
      object.current = null
    }
  }

  // if the model has changed
  useEffect(() => {
    setReady(false)
    setLoaded(false)
    return () => { 
      // Because when we switch models we recreate character(create new component) we need to set prev component object's id to null
      if(object.current)
        object.current.userData.id = null
    }
  }, [props.model])

  useEffect(() => {
    if (object.current) {
      object.current.orthoIcon.changeFirstText(props.name ? props.name : props.displayName)
    }
  }, [props.displayName, props.name])

  // if the model’s data has changed
  useEffect(() => {
    if (ready) {
      console.log(type, id, 'add')

      const { mesh, skeleton, armatures, originalHeight, boneLengthScale, parentRotation, parentPosition } = characterFactory(modelData)
      // make a clone of the initial skeleton pose, for comparison
      originalSkeleton.current = skeleton.clone()
      originalSkeleton.current.bones = originalSkeleton.current.bones.map(bone => bone.clone())

      object.current = new THREE.Object3D()
      object.current.add(...armatures)
      object.current.add(mesh)
      let bonesHelper = new BonesHelper( skeleton.bones[0].parent, object.current, { boneLengthScale, cacheKey: props.model } )

      object.current.userData.id = id
      object.current.userData.type = type
      object.current.userData.originalHeight = originalHeight
      object.current.userData.locked = props.locked
      // FIXME get current .models from getState()
      object.current.userData.modelSettings = initialState.models[props.model] || {}

      object.current.orthoIcon = new IconSprites( type, props.name?props.name:props.displayName, object.current )

      object.current.userData.mesh = mesh

      scene.add(object.current)
      scene.add(object.current.orthoIcon)

      mesh.layers.disable(0)
      mesh.layers.enable(1)
      mesh.layers.disable(2)
      mesh.layers.enable(3)

      bonesHelper.traverse(child => {
        child.layers.disable(0)
        child.layers.enable(1)
        child.layers.enable(2)
      })
      bonesHelper.hit_meshes.forEach(h => {
        h.layers.disable(0)
        h.layers.enable(1)
        h.layers.enable(2)
      })
      bonesHelper.cones.forEach(c => {
        c.layers.disable(0)
        c.layers.enable(1)
        c.layers.disable(2)
      })

      object.current.bonesHelper = bonesHelper
      object.current.userData.skeleton = skeleton
      object.current.userData.boneLengthScale = boneLengthScale
      object.current.userData.parentRotation = parentRotation
      object.current.userData.parentPosition = parentPosition
      object.current.resetToStandardSkeleton = resetToStandardSkeleton
      scene.add(object.current.bonesHelper)

      let domElement = largeRenderer.current.domElement
      objectRotationControl.current = new ObjectRotationControl(scene, camera, domElement, object.current.uuid)
      let boneRotation = objectRotationControl.current
      boneRotation.setUpdateCharacter((name, rotation) => {updateCharacterSkeleton({
        id,
        name : name,
        rotation:
        {
          x : rotation.x,
          y : rotation.y,
          z : rotation.z,
        }
      } )})
      resetPose()
      fullyUpdateSkeleton()
    }

    return function cleanup () {
      setAttachables(!object.current ? null : object.current.attachables ? object.current.attachables.concat([]) : null)
      setModelChange(!object.current ? false : object.current.attachables ? true : false)
      doCleanup()
      // setLoaded(false)
    }
  }, [ready])

  useEffect(() => {
    return function cleanup () {
      console.log('component cleanup')
      doCleanup()
      setReady(false)
      setLoaded(false)
    }
  }, [])

  let isRotating = useRef(false)

  let isControllerRotatingCurrent = useRef(false)

  let startingObjectQuaternion = useRef(null)
  let startingDeviceOffset = useRef(null)
  let startingObjectOffset = useRef(null)
  let offset = useRef(null)

  let virtual = useRef({
    roll: 0,
    pitch: 0,
    yaw: 0
  })

  // Updates character skeleton by saving it's position
  // Hack to fix position difference in sg and xr boneas
  const fullyUpdateSkeleton = () => {
    let skeleton = object.current.userData.skeleton
    let changedSkeleton = []
    let position = new THREE.Vector3()
    let scalarForBones = 1
    if(props.posePresetId === defaultPosePreset.id)
      scalarForBones = object.current.userData.boneLengthScale === 100 ? 100 : 1
    for(let i = 0; i < skeleton.bones.length; i++) {
      let bone = skeleton.bones[i]
      if(bone.name.includes("leaf")) continue
      let rotation = bone.rotation

      position = bone.position.clone().applyMatrix4(object.current.getInverseMatrixWorld())
      position.multiplyScalar(scalarForBones)
      changedSkeleton.push({ 
        name: bone.name,
        position: { 
          x: position.x, 
          y: position.y, 
          z: position.z 
        }, 
        rotation: { 
          x: rotation.x, 
          y: rotation.y, 
          z: rotation.z
        }
      })
    }
    updateCharacterIkSkeleton({id, skeleton:changedSkeleton})
  }

  const saveAttachablesPositions = () => {
    if(!object.current || !object.current.attachables) return
    object.current.updateWorldMatrix(true, true)
    for(let i = 0; i < object.current.attachables.length; i++) {
      object.current.attachables[i].saveToStore()
    }
  }

  let startingDeviceRotation = useRef(null)
  let currentBoneSelected = useRef(null)

  const updateSkeleton = () => {
    let skeleton = object.current.userData.skeleton
    
    if (Object.values(props.skeleton).length) {
      fixRootBone()
      for (bone of skeleton.bones) {
        let userState = props.skeleton[bone.name]
        let systemState = originalSkeleton.current.getBoneByName(bone.name).clone()
        let state = userState || systemState
        bone.rotation.x = state.rotation.x
        bone.rotation.y = state.rotation.y
        bone.rotation.z = state.rotation.z
       
      }
    } else {
      let skeleton = object.current.userData.skeleton
      skeleton.pose()
      fixRootBone()
    }
  }

  const updateSkeletonHand = () => {
    let skeleton = object.current.userData.skeleton
    let handSkeletonKeys = Object.keys(props.handSkeleton)
    let skeletonBones = skeleton.bones.filter(bone => handSkeletonKeys.includes(bone.name))
    for ( let i = 0; i < skeletonBones.length; i++ ) {
      let key = skeletonBones[i].name
      let bone = skeletonBones[i]
      let handBone = props.handSkeleton[key]
      bone.rotation.x = handBone.rotation.x
      bone.rotation.y = handBone.rotation.y
      bone.rotation.z = handBone.rotation.z
    }
  }

  const getCurrentControllerRotation = (device, virtual) => {

    let virtualPitch = virtual.pitch,
      virtualRoll = virtual.roll,
      virtualYaw = virtual.yaw

    let { accelX, accelY, accelZ, gyroPitch, gyroRoll, gyroYaw } = device.motion
    virtualYaw = virtualYaw + ((0 - virtualYaw)*0.003)
    virtualRoll = virtualRoll + ((adjusted(gyroRoll) - virtualRoll)*0.003)

    if (adjusted(gyroPitch)) {
      virtualPitch = virtualPitch + (((-adjusted(gyroPitch)) - virtualPitch)*0.003)
    }
    if (adjusted(accelY)) {
      virtualYaw += adjusted(accelY)/10.0
    }

    if (adjusted(accelX)) {
      virtualPitch += adjusted(accelX)/10.0
    }

    if (adjusted(accelZ)) {
      virtualRoll += adjusted(accelZ)/10.0
    }

    let q = new THREE.Quaternion()
      .setFromEuler(
        new THREE.Euler(
          virtualPitch,
          virtualYaw,
          virtualRoll
        )
      )

      return {
        quaternion:q,
        virtualPitch,
        virtualRoll,
        virtualYaw
      }
  }

  //
  // updaters
  //
  // FIXME frame delay between redux update and react render here
  //

  //#region Camera changing
  useEffect(() => {
    if(!ready || !camera) return
    SGIkHelper.getInstance().setCamera(camera)
    objectRotationControl.current.setCamera(camera)
  }, [camera, ready])
  //#endregion
  
  useEffect(() => {
    
    if (object.current) {
      object.current.position.x = props.x
      object.current.position.z = props.y
      object.current.position.y = props.z
      object.current.orthoIcon.position.copy(object.current.position)
      saveAttachablesPositions()
      
    }
  }, [props.model, props.x, props.y, props.z, ready])
  
  useEffect(() => {
    if (!object.current) return
    object.current.userData.locked = props.locked
  }, [props.locked, ready])

  useEffect(() => {
    if (object.current) {
      if (props.rotation.y || props.rotation.y==0) {
        object.current.rotation.y = props.rotation.y
        object.current.icon.material.rotation = -props.rotation.y
        //object.current.rotation.x = props.rotation.x
        //object.current.rotation.z = props.rotation.z
      } else {
        object.current.rotation.y = props.rotation
        object.current.orthoIcon.icon.material.rotation = props.rotation + Math.PI
      }
    }
  }, [props.model, props.rotation, ready])

  const resetPose = () => {
    if (!object.current) return
    let skeleton = object.current.userData.skeleton
    skeleton.pose()
    updateSkeleton()
  }

  const resetToStandardSkeleton = () => {
    let skeleton = object.current.userData.skeleton
    if (Object.values(props.skeleton).length) {
      fixRootBone()
      for (bone of skeleton.bones) {
        let userState = defaultPosePreset.state.skeleton[bone.name]
        let systemState = originalSkeleton.current.getBoneByName(bone.name).clone()
        let state = userState || systemState
        bone.rotation.x = state.rotation.x
        bone.rotation.y = state.rotation.y
        bone.rotation.z = state.rotation.z
        bone.updateMatrixWorld(true)
      }
    }
  }

  const fixRootBone = () => {
    let { boneLengthScale, parentRotation, parentPosition } = object.current.userData
    let skeleton = object.current.userData.skeleton

    // fb converter scaled object
    // e.g.: all built-in character models
    if (boneLengthScale === 100) {
      if (props.skeleton['Hips']) {
        // we already have correct values, don't multiply the root bone
      } else {
        skeleton.bones[0].quaternion.multiply(parentRotation)
      }
      skeleton.bones[0].position.copy(parentPosition)
    }  
  }

  useEffect(() => {
    if (!ready) return
    if (!props.posePresetId) return
    resetPose()
    fullyUpdateSkeleton()
    saveAttachablesPositions()
  }, [props.posePresetId])

  useEffect(() => {
    if (!ready) return
    if (!props.handPosePresetId) return
    if (!props.handSkeleton) return
    resetPose()
    updateSkeletonHand()
    saveAttachablesPositions()
  }, [props.handPosePresetId, props.handSkeleton])

  useEffect(() => {
    if(!props.characterPresetId) return 
    if(object.current && object.current.attachables) {
      let attachablesToDelete = []
      for(let i = 0; i < object.current.attachables.length; i++) {
        attachablesToDelete.push(object.current.attachables[i].userData.id)
      }
      deleteObjects(attachablesToDelete)
    }
  }, [props.characterPresetId])

  // HACK force reset skeleton pose on Board UUID change
  useEffect(() => {
    if (!ready) return
    if (!boardUid) return

    console.log(type, id, 'changed boards')
    resetPose()
    if(props.handSkeleton && Object.keys(props.handSkeleton).length > 0)
    updateSkeletonHand()
  }, [boardUid])

  useEffect(() => {
    if (!ready) return
    if (!object.current) return

    //console.log(type, id, 'skeleton')
    updateSkeleton()
    if(props.handSkeleton && Object.keys(props.handSkeleton).length > 0)
      updateSkeletonHand()
  }, [props.model, props.skeleton, ready])



  useEffect(() => {
    if (!ready) return
    if (props.model !== object.current.userData.modelSettings.id) return
    if (object.current) {
      if (object.current.userData.modelSettings.height) {
        let originalHeight = object.current.userData.originalHeight
        let scale = props.height / originalHeight
        object.current.scale.set( scale, scale, scale )
        object.current.userData.height = props.height
      } else {
        object.current.scale.setScalar( props.height )
      }
      object.current.bonesHelper.updateMatrixWorld()
    }
  }, [props.model, props.height, props.skeleton, ready])

  useEffect(() => {
    if (!ready) return

    if (object.current) {
      // adjust head proportionally
      let skeleton = object.current.userData.skeleton
      let headBone = skeleton.getBoneByName('Head')

      if (headBone && object.current.userData.modelSettings.height) {
        let baseHeadScale = object.current.userData.modelSettings.height / props.height

        //head bone
        headBone.scale.setScalar( baseHeadScale )
        headBone.scale.setScalar( props.headScale )
      }
    }
  }, [props.model, props.headScale, props.skeleton, ready])

  useEffect(() => {
    if (!ready) return
    if (!object.current) return

    if (object.current) {
      let {material} = object.current.userData.mesh

      material.emissive.set(props.tintColor)
    }
  }, [props.model, props.tintColor, ready])

  useEffect(() => {
    if (!ready) return
    if (!object.current) return
    let mesh = object.current.userData.mesh

    let modelSettings = initialState.models[props.model]

    if (modelSettings && modelSettings.validMorphTargets && modelSettings.validMorphTargets.length
        && mesh.morphTargetInfluences ) {
      mesh.material.morphTargets = mesh.material.morphNormals = true
      modelSettings.validMorphTargets.forEach((name, index) => {
          mesh.morphTargetInfluences[ index ] = props.morphTargets[ name ]
      })
    } else {
      mesh.material.morphTargets = mesh.material.morphNormals = false
    }
  }, [props.morphTargets, ready])

  useEffect(() => {
    console.log(type, id, 'isSelected', isSelected)
    if (!ready) return
    if (!object.current) return
    if (isSelected)
    {

      for (var cone of object.current.bonesHelper.cones) {
        object.current.bonesHelper.add(cone)
      }
      if ( !isCustomModel(props.model) ) {
        SGIkHelper.getInstance().initialize(scene, object.current, object.current.userData.modelSettings.height, object.current.userData.mesh, props)
        object.current.add(SGIkHelper.getInstance())
        SGIkHelper.getInstance().updateMatrixWorld(true)
      }
    } else {
      object.current.remove(SGIkHelper.getInstance())
      SGIkHelper.getInstance().removeFromParent(object.current.userData.mesh.uuid)
      for (var cone of object.current.bonesHelper.cones)
        object.current.bonesHelper.remove(cone)
    }

    let mesh = object.current.userData.mesh
    if ( mesh.material.length > 0 ) {
      mesh.material.forEach(material => {
        material.userData.outlineParameters =
          isSelected
            ? {
              thickness: 0.009,
              color: [ 122/256.0, 114/256.0, 233/256.0 ]
            }
            : {
              thickness: 0.009,
              color: [ 0, 0, 0 ],
            }
      })
    } else {
      mesh.material.userData.outlineParameters =
        isSelected
          ? {
            thickness: 0.009,
            color: [ 122/256.0/2, 114/256.0/2, 233/256.0/2 ]
          }
          : {
            thickness: 0.009,
            color: [ 0, 0, 0 ],
          }
    }

    if(modelChanged) {
      if(attachables) {
        if(isCustomModel(props.model)) {
          deleteObjects(attachables.map(attachable => attachable.userData.id))
        } else {
          for(let i = 0; i < attachables.length; i++) {
            attachables[i].rebindAttachable(props.height / object.current.userData.originalHeight)
          }
        }
       
        setAttachables(null)
      }
      setModelChange(false)
    }

    object.current.orthoIcon.setSelected(isSelected)
  }, [props.model, isSelected, ready])

  // Watches for poletargets changes and applies them
  useEffect(() => {
    if(!ready) return
    if(!props.poleTargets) return
    SGIkHelper.getInstance().updatePoleTarget(object.current, props.poleTargets)
  }, [props.poleTargets, ready])

  useEffect(() => {
    if (!ready) return
    if (!object.current) return

    // if there was a prior selected bone
    if (currentBoneSelected.current) {
      // reset it
      currentBoneSelected.current.connectedBone.material.color = new THREE.Color( 0x7a72e9 )
      currentBoneSelected.current = null
    }
    // was a bone selected?
    if (selectedBone) {
      // find the 3D Bone matching the selectedBone uuid
      let bone = object.current
        .userData
        .skeleton
        .bones.find(b => b.uuid == selectedBone)


      if (bone) {
        currentBoneSelected.current = bone
        currentBoneSelected.current.connectedBone.material.color = new THREE.Color( 0x242246 )
        objectRotationControl.current.selectObject(bone, selectedBone)
      }

    }
    else{
      objectRotationControl.current.deselectObject()
    }
  }, [selectedBone, ready])

  useEffect(() => {
    if (!object.current) return
    if (!isSelected) return
    if ( devices[0] && devices[0].digital.circle ) //if pressed
    {
      // zero out controller rotation and start rotating bone

      let target
      let skeleton = object.current.userData.skeleton
      if (selectedBone) {
        target = skeleton.bones.find(bone => bone.uuid == selectedBone) || object.current
      } else {
        target = object.current
      }

      let deviceQuaternion
      if (!isControllerRotatingCurrent.current)
      {
        //new rotation
        isControllerRotatingCurrent.current = true
        let startValues = getCurrentControllerRotation(devices[0], virtual.current)
        startingDeviceRotation.current = startValues.quaternion

        startingDeviceOffset.current =  new THREE.Quaternion().clone().inverse().multiply(startingDeviceRotation.current).normalize().inverse()
        startingObjectQuaternion.current = target.quaternion.clone()
        startingObjectOffset.current =  new THREE.Quaternion().clone().inverse().multiply(startingObjectQuaternion.current)
        //console.log('starting rotation: ', startingDeviceRotation.current)
      }
      let midddleValues = getCurrentControllerRotation(devices[0], virtual.current)
      deviceQuaternion = midddleValues.quaternion
      virtual.current = {
        roll: midddleValues.virtualRoll,
        pitch: midddleValues.virtualPitch,
        yaw: midddleValues.virtualYaw
      }

      let objectQuaternion = applyDeviceQuaternion({
        parent: target.parent,
        startingDeviceOffset: startingDeviceOffset.current,
        startingObjectOffset: startingObjectOffset.current,
        startingObjectQuaternion: startingObjectQuaternion.current,
        deviceQuaternion,
        camera
      })

      // APPLY THE ROTATION TO THE TARGET OBJECT
      target.quaternion.copy(objectQuaternion.normalize())
      let rotation = new THREE.Euler()
      if (selectedBone) {


        rotation.setFromQuaternion( objectQuaternion.normalize(), "YXZ" )
        updateCharacterSkeleton({
          id,
          name: target.name,
          rotation: {
            x: target.rotation.x,
            y: target.rotation.y,
            z: target.rotation.z
          }
        })
      } else {
        rotation.setFromQuaternion( objectQuaternion.normalize(), "YXZ" )
        updateObject(target.userData.id, {
          rotation: target.rotation.y
        })
      }

    } else {
      if (devices[0] && devices[0].digital.circle === false && isControllerRotatingCurrent.current)
      {
        //console.log(' CIRCLE button up ')
        isControllerRotatingCurrent.current = false
        virtual.current = {
          roll: 0,
          pitch: 0,
          yaw: 0
        }
      }

      // do something on button up?
    }
  }, [devices])

  useEffect(() => {
    if (!object.current) return
    if (!isSelected) return

    if (remoteInput.mouseMode || remoteInput.orbitMode) return

    // FIND THE TARGET
    // note that we don't want to mutate anything in the scene directly here
    // (e.g.: we don't want to make any direct changes to `target`)
    // instead we dispatch an event describing how we want the system to update
    let target
    let skeleton = object.current.userData.skeleton
    if (selectedBone) {
      target = skeleton.bones.find(bone => bone.uuid == selectedBone) || object.current
    } else {
      target = object.current
    }

    if (remoteInput.down) {
      if (target) {
        let [ alpha, beta, gamma ] = remoteInput.mag.map(THREE.Math.degToRad)
        let magValues = remoteInput.mag
        let deviceQuaternion
        if (!isRotating.current) {
          // The first time rotation starts, get the starting device rotation and starting target object rotation

          isRotating.current = true
          offset.current = 0-magValues[0]
          deviceQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(beta, alpha + (offset.current*(Math.PI/180)),-gamma, 'YXZ')).multiply(new THREE.Quaternion().setFromAxisAngle( new THREE.Vector3( 1, 0, 0 ), -Math.PI / 2 ))
          startingDeviceOffset.current =  new THREE.Quaternion().clone().inverse().multiply(deviceQuaternion).normalize().inverse()

          startingObjectQuaternion.current = target.quaternion.clone()
          startingObjectOffset.current =  new THREE.Quaternion().clone().inverse().multiply(startingObjectQuaternion.current)
        } else {
          deviceQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(beta, alpha + (offset.current*(Math.PI/180)),-gamma, 'YXZ')).multiply(new THREE.Quaternion().setFromAxisAngle( new THREE.Vector3( 1, 0, 0 ), -Math.PI / 2 ))
        }

        // While rotating, perform the rotations

        // get device's offset

        let objectQuaternion = applyDeviceQuaternion({
          parent: target.parent,
          startingDeviceOffset: startingDeviceOffset.current,
          startingObjectOffset: startingObjectOffset.current,
          startingObjectQuaternion: startingObjectQuaternion.current,
          deviceQuaternion,
          camera
        })

        // GET THE DESIRED ROTATION FOR THE TARGET OBJECT

        let rotation = new THREE.Euler()

        if (selectedBone) {
          rotation.setFromQuaternion( objectQuaternion.normalize() )
          updateCharacterSkeleton({
            id,
            name: target.name,
            rotation: {
              x: rotation.x,
              y: rotation.y,
              z: rotation.z
            }
          })
        } else {
          rotation.setFromQuaternion( objectQuaternion.normalize(), "YXZ" )
          updateObject(target.userData.id, {
            rotation: rotation.y
          })
        }
      }
    } else {
      // not pressed anymore, reset
      isRotating.current = false

      startingDeviceOffset.current = null
      startingObjectQuaternion.current = null
      startingObjectOffset.current = null
    }
  }, [remoteInput])

  useEffect(() => {
    if (!ready) return

    if (object.current) {
      object.current.visible = props.visible
      object.current.orthoIcon.visible = props.visible
      object.current.bonesHelper.visible = props.visible
      object.current.bonesHelper.hit_meshes.map(hit => hit.visible = props.visible)
    }
  }, [props.visible, ready])

  useEffect(() => {
    if (!ready && modelData) {
      if (isValidSkinnedMesh(modelData)) {
        console.log(type, id, 'got valid mesh')
        setReady(true)
      } else {
        alert('This model doesn’t contain a Skinned Mesh. Please load it as an Object, not a Character.')

        // HACK undefined means an error state
        setLoaded(undefined)
      }
    }
  }, [modelData, ready])

  useEffect(() => {
    if (ready) {
      setLoaded(true)
    }
  }, [ready])

  return null
})

module.exports = Character
