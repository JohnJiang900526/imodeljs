/*---------------------------------------------------------------------------------------------
* Copyright (c) 2019 Bentley Systems, Incorporated. All rights reserved.
* Licensed under the MIT License. See LICENSE.md in the project root for license terms.
*--------------------------------------------------------------------------------------------*/
/** @module WebGL */

import { IModelError, RenderTexture, RenderMaterial, Gradient, ImageBuffer, ElementAlignedBox3d, ColorDef, QPoint3dList, QParams3d, QPoint3d } from "@bentley/imodeljs-common";
import {
  ClipVector, Transform, Point3d, ClipUtilities, PolyfaceBuilder, Point2d, IndexedPolyface, Range3d,
  IndexedPolyfaceVisitor, Triangulator, StrokeOptions, HalfEdgeGraph, HalfEdge, HalfEdgeMask,
} from "@bentley/geometry-core";
import {
  InstancedGraphicParams,
  RenderGraphic,
  GraphicBranch,
  RenderSystem,
  RenderDiagnostics,
  RenderTarget,
  RenderClipVolume,
  GraphicList,
  PackedFeatureTable,
} from "../System";
import { SkyBox } from "../../DisplayStyleState";
import { OnScreenTarget, OffScreenTarget } from "./Target";
import { GraphicBuilder, GraphicType } from "../GraphicBuilder";
import { PrimitiveBuilder } from "../primitives/geometry/GeometryListBuilder";
import { PointCloudArgs } from "../primitives/PointCloudPrimitive";
import { PointStringParams, MeshParams, PolylineParams } from "../primitives/VertexTable";
import { MeshArgs } from "../primitives/mesh/MeshPrimitives";
import { Branch, Batch, GraphicsArray } from "./Graphic";
import { IModelConnection } from "../../IModelConnection";
import { assert, BentleyStatus, Dictionary, IDisposable, dispose, Id64String } from "@bentley/bentleyjs-core";
import { Techniques } from "./Technique";
import { IModelApp } from "../../IModelApp";
import { ViewRect, Viewport } from "../../Viewport";
import { RenderState } from "./RenderState";
import { FrameBufferStack, DepthBuffer } from "./FrameBuffer";
import { RenderBuffer } from "./RenderBuffer";
import { TextureHandle, Texture, TextureMonitor } from "./Texture";
import { GL } from "./GL";
import { PolylineGeometry } from "./Polyline";
import { PointStringGeometry } from "./PointString";
import { MeshGraphic } from "./Mesh";
import { PointCloudGeometry } from "./PointCloud";
import { LineCode } from "./EdgeOverrides";
import { Material } from "./Material";
import { SkyBoxQuadsGeometry, SkySphereViewportQuadGeometry } from "./CachedGeometry";
import { SkyBoxPrimitive, Primitive } from "./Primitive";
import { ClipPlanesVolume, ClipMaskVolume } from "./ClipVolume";
import { TextureUnit } from "./RenderFlags";
import { UniformHandle } from "./Handle";
import { Debug } from "./Diagnostics";

export const enum ContextState {
  Uninitialized,
  Success,
  Error,
}

/** Describes the type of a render target. Used by Capabilities to represent maximum precision render target available on host system. */
export const enum RenderType {
  TextureUnsignedByte,
  TextureHalfFloat,
  TextureFloat,
}

/**
 * Describes the type of a depth buffer. Used by Capabilities to represent maximum depth buffer precision available on host system.
 * Note: the commented-out values are unimplemented but left in place for reference, in case desired for future implementation.
 */
export const enum DepthType {
  RenderBufferUnsignedShort16,     // core to WebGL1
  // TextureUnsignedShort16,       // core to WebGL2; available to WebGL1 via WEBGL_depth_texture
  // TextureUnsignedInt24,         // core to WebGL2
  TextureUnsignedInt24Stencil8,    // core to WebGL2; available to WebGL1 via WEBGL_depth_texture
  TextureUnsignedInt32,            // core to WebGL2; available to WebGL1 via WEBGL_depth_texture
  // TextureFloat32,               // core to WebGL2
  // TextureFloat32Stencil8,       // core to WeBGL2
}

const forceNoDrawBuffers = false;
const forceHalfFloat = false;
const debugTextureLifetime = false;

/** Describes the rendering capabilities of the host system. */
export class Capabilities {
  private _maxRenderType: RenderType = RenderType.TextureUnsignedByte;
  private _maxDepthType: DepthType = DepthType.RenderBufferUnsignedShort16;
  private _maxTextureSize: number = 0;
  private _maxColorAttachments: number = 0;
  private _maxDrawBuffers: number = 0;
  private _maxFragTextureUnits: number = 0;
  private _maxVertTextureUnits: number = 0;
  private _maxVertAttribs: number = 0;
  private _maxVertUniformVectors: number = 0;
  private _maxVaryingVectors: number = 0;
  private _maxFragUniformVectors: number = 0;

  private _extensionMap: { [key: string]: any } = {}; // Use this map to store actual extension objects retrieved from GL.

  public get maxRenderType(): RenderType { return this._maxRenderType; }
  public get maxDepthType(): DepthType { return this._maxDepthType; }
  public get maxTextureSize(): number { return this._maxTextureSize; }
  public get maxColorAttachments(): number { return this._maxColorAttachments; }
  public get maxDrawBuffers(): number { return this._maxDrawBuffers; }
  public get maxFragTextureUnits(): number { return this._maxFragTextureUnits; }
  public get maxVertTextureUnits(): number { return this._maxVertTextureUnits; }
  public get maxVertAttribs(): number { return this._maxVertAttribs; }
  public get maxVertUniformVectors(): number { return this._maxVertUniformVectors; }
  public get maxVaryingVectors(): number { return this._maxVaryingVectors; }
  public get maxFragUniformVectors(): number { return this._maxFragUniformVectors; }

  /** These getters check for existence of extension objects to determine availability of features.  In WebGL2, could just return true for some. */
  public get supportsNonPowerOf2Textures(): boolean { return false; }
  public get supportsDrawBuffers(): boolean { return this.queryExtensionObject<WEBGL_draw_buffers>("WEBGL_draw_buffers") !== undefined; }
  public get supportsInstancing(): boolean { return this.queryExtensionObject<ANGLE_instanced_arrays>("ANGLE_instanced_arrays") !== undefined; }
  public get supports32BitElementIndex(): boolean { return this.queryExtensionObject<OES_element_index_uint>("OES_element_index_uint") !== undefined; }
  public get supportsTextureFloat(): boolean { return this.queryExtensionObject<OES_texture_float>("OES_texture_float") !== undefined; }
  public get supportsTextureHalfFloat(): boolean { return this.queryExtensionObject<OES_texture_half_float>("OES_texture_half_float") !== undefined; }
  public get supportsShaderTextureLOD(): boolean { return this.queryExtensionObject<EXT_shader_texture_lod>("EXT_shader_texture_lod") !== undefined; }

  public get supportsMRTTransparency(): boolean { return this.maxColorAttachments >= 2; }
  public get supportsMRTPickShaders(): boolean { return this.maxColorAttachments >= 4; }

  /** Queries an extension object if available.  This is necessary for other parts of the system to access some constants within extensions. */
  public queryExtensionObject<T>(ext: string): T | undefined {
    const extObj: any = this._extensionMap[ext];
    return (null !== extObj) ? extObj as T : undefined;
  }

  /** Initializes the capabilities based on a GL context. Must be called first. */
  public init(gl: WebGLRenderingContext): boolean {
    this._maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this._maxFragTextureUnits = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS);
    this._maxVertTextureUnits = gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS);
    this._maxVertAttribs = gl.getParameter(gl.MAX_VERTEX_ATTRIBS);
    this._maxVertUniformVectors = gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS);
    this._maxVaryingVectors = gl.getParameter(gl.MAX_VARYING_VECTORS);
    this._maxFragUniformVectors = gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS);

    const extensions = gl.getSupportedExtensions(); // This just retrieves a list of available extensions (not necessarily enabled).
    if (extensions) {
      for (const ext of extensions) {
        if ((!forceNoDrawBuffers && ext === "WEBGL_draw_buffers") || ext === "OES_element_index_uint" || (!forceHalfFloat && ext === "OES_texture_float") ||
          ext === "OES_texture_half_float" || ext === "WEBGL_depth_texture" || ext === "EXT_color_buffer_float" ||
          ext === "EXT_shader_texture_lod" || ext === "ANGLE_instanced_arrays") {
          const extObj: any = gl.getExtension(ext); // This call enables the extension and returns a WebGLObject containing extension instance.
          if (null !== extObj)
            this._extensionMap[ext] = extObj;
        }
      }
    }

    const dbExt: WEBGL_draw_buffers | undefined = this.queryExtensionObject<WEBGL_draw_buffers>("WEBGL_draw_buffers");
    this._maxColorAttachments = dbExt !== undefined ? gl.getParameter(dbExt.MAX_COLOR_ATTACHMENTS_WEBGL) : 1;
    this._maxDrawBuffers = dbExt !== undefined ? gl.getParameter(dbExt.MAX_DRAW_BUFFERS_WEBGL) : 1;

    // Determine the maximum color-renderable attachment type.
    if (!forceHalfFloat && this.isTextureRenderable(gl, gl.FLOAT))
      this._maxRenderType = RenderType.TextureFloat;
    else {
      const hfExt: OES_texture_half_float | undefined = this.queryExtensionObject<OES_texture_half_float>("OES_texture_half_float");
      this._maxRenderType = (hfExt !== undefined && this.isTextureRenderable(gl, hfExt.HALF_FLOAT_OES)) ? RenderType.TextureHalfFloat : RenderType.TextureUnsignedByte;
    }

    // Determine the maximum depth attachment type.
    // this._maxDepthType = this.queryExtensionObject("WEBGL_depth_texture") !== undefined ? DepthType.TextureUnsignedInt32 : DepthType.RenderBufferUnsignedShort16;
    this._maxDepthType = this.queryExtensionObject("WEBGL_depth_texture") !== undefined ? DepthType.TextureUnsignedInt24Stencil8 : DepthType.RenderBufferUnsignedShort16;

    this.debugPrint(gl);

    // Return based on currently-required features.  This must change if the amount used is increased or decreased.
    return this._hasRequiredFeatures && this._hasRequiredTextureUnits;
  }

  public static create(gl: WebGLRenderingContext): Capabilities | undefined {
    const caps = new Capabilities();
    return caps.init(gl) ? caps : undefined;
  }

  /** Determines if a particular texture type is color-renderable on the host system. */
  private isTextureRenderable(gl: WebGLRenderingContext, texType: number): boolean {
    const tex: WebGLTexture | null = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, texType, null);

    const fb: WebGLFramebuffer | null = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

    const fbStatus: number = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    gl.deleteTexture(tex);

    gl.getError(); // clear any errors

    return fbStatus === gl.FRAMEBUFFER_COMPLETE;
  }

  /** Determines if the required features are supported (list could change).  These are not necessarily extensions (looking toward WebGL2). */
  private get _hasRequiredFeatures(): boolean {
    return this.supports32BitElementIndex;
  }

  /** Determines if the required number of texture units are supported in vertex and fragment shader (could change). */
  private get _hasRequiredTextureUnits(): boolean {
    return this.maxFragTextureUnits > 4 && this.maxVertTextureUnits > 5;
  }

  private debugPrint(gl: WebGLRenderingContext) {
    if (!Debug.printEnabled)
      return;

    Debug.print(() => "GLES Capabilities Information:");
    Debug.print(() => "     hasRequiredFeatures : " + this._hasRequiredFeatures);
    Debug.print(() => " hasRequiredTextureUnits : " + this._hasRequiredTextureUnits);
    Debug.print(() => "              GL_VERSION : " + gl.getParameter(gl.VERSION));
    Debug.print(() => "               GL_VENDOR : " + gl.getParameter(gl.VENDOR));
    Debug.print(() => "             GL_RENDERER : " + gl.getParameter(gl.RENDERER));
    Debug.print(() => "          maxTextureSize : " + this.maxTextureSize);
    Debug.print(() => "     maxColorAttachments : " + this.maxColorAttachments);
    Debug.print(() => "          maxDrawBuffers : " + this.maxDrawBuffers);
    Debug.print(() => "     maxFragTextureUnits : " + this.maxFragTextureUnits);
    Debug.print(() => "     maxVertTextureUnits : " + this.maxVertTextureUnits);
    Debug.print(() => "     nonPowerOf2Textures : " + (this.supportsNonPowerOf2Textures ? "yes" : "no"));
    Debug.print(() => "             drawBuffers : " + (this.supportsDrawBuffers ? "yes" : "no"));
    Debug.print(() => "              instancing : " + (this.supportsInstancing ? "yes" : "no"));
    Debug.print(() => "       32BitElementIndex : " + (this.supports32BitElementIndex ? "yes" : "no"));
    Debug.print(() => "            textureFloat : " + (this.supportsTextureFloat ? "yes" : "no"));
    Debug.print(() => "        textureHalfFloat : " + (this.supportsTextureHalfFloat ? "yes" : "no"));
    Debug.print(() => "        shaderTextureLOD : " + (this.supportsShaderTextureLOD ? "yes" : "no"));

    switch (this.maxRenderType) {
      case RenderType.TextureUnsignedByte:
        Debug.print(() => "           maxRenderType : TextureUnsigedByte");
        break;
      case RenderType.TextureHalfFloat:
        Debug.print(() => "           maxRenderType : TextureHalfFloat");
        break;
      case RenderType.TextureFloat:
        Debug.print(() => "           maxRenderType : TextureFloat");
        break;
      default:
        Debug.print(() => "           maxRenderType : Unknown");
    }

    switch (this.maxDepthType) {
      case DepthType.RenderBufferUnsignedShort16:
        Debug.print(() => "            maxDepthType : RenderBufferUnsignedShort16");
        break;
      case DepthType.TextureUnsignedInt24Stencil8:
        Debug.print(() => "            maxDepthType : TextureUnsignedInt24Stencil8");
        break;
      case DepthType.TextureUnsignedInt32:
        Debug.print(() => "            maxDepthType : TextureUnsignedInt32");
        break;
      default:
        Debug.print(() => "            maxDepthType : Unknown");
    }
  }
}

/** Id map holds key value pairs for both materials and textures, useful for caching such objects. */
export class IdMap implements IDisposable {
  /** Mapping of materials by their key values. */
  public readonly materials: Map<string, RenderMaterial>;
  /** Mapping of textures by their key values. */
  public readonly textures: Map<string, RenderTexture>;
  /** Mapping of textures using gradient symbology. */
  public readonly gradients: Dictionary<Gradient.Symb, RenderTexture>;
  /** Mapping of ClipVectors to corresponding clipping volumes. */
  public readonly clipVolumes: Map<ClipVector, RenderClipVolume>;

  public constructor() {
    this.materials = new Map<string, RenderMaterial>();
    this.textures = new Map<string, RenderTexture>();
    this.gradients = new Dictionary<Gradient.Symb, RenderTexture>(Gradient.Symb.compareSymb);
    this.clipVolumes = new Map<ClipVector, RenderClipVolume>();
  }

  public dispose() {
    const textureArr = Array.from(this.textures.values());
    const gradientArr = this.gradients.extractArrays().values;
    const clipVolumeArr = Array.from(this.clipVolumes.values());
    for (const texture of textureArr)
      dispose(texture);
    for (const gradient of gradientArr)
      dispose(gradient);
    for (const clipVolume of clipVolumeArr)
      dispose(clipVolume);
    this.textures.clear();
    this.gradients.clear();
    this.clipVolumes.clear();
  }

  /** Add a material to this IdMap, given that it has a valid key. */
  public addMaterial(material: RenderMaterial) {
    if (material.key)
      this.materials.set(material.key, material);
  }

  /** Add a texture to this IdMap, given that it has a valid key. */
  public addTexture(texture: RenderTexture) {
    if (texture.key)
      this.textures.set(texture.key, texture);
  }

  /** Add a texture to this IdMap using gradient symbology. */
  public addGradient(gradientSymb: Gradient.Symb, texture: RenderTexture) {
    this.gradients.set(gradientSymb, texture);
  }

  /** Find a cached material using its key. If not found, returns undefined. */
  public findMaterial(key: string): RenderMaterial | undefined {
    return this.materials.get(key);
  }

  /** Find a cached gradient using the gradient symbology. If not found, returns undefined. */
  public findGradient(symb: Gradient.Symb): RenderTexture | undefined {
    return this.gradients.get(symb);
  }

  /** Find or create a new material given material parameters. This will cache the material if its key is valid. */
  public getMaterial(params: RenderMaterial.Params): RenderMaterial {
    if (!params.key)
      return new Material(params);

    let material = this.materials.get(params.key);
    if (!material) {
      material = new Material(params);
      this.materials.set(params.key, material);
    }
    return material;
  }

  private createTexture(params: RenderTexture.Params, handle?: TextureHandle): Texture | undefined {
    if (undefined === handle)
      return undefined;

    const texture = new Texture(params, handle);
    this.addTexture(texture);
    return texture;
  }

  /** Attempt to create and return a new texture from an ImageBuffer. This will cache the texture if its key is valid */
  private createTextureFromImageBuffer(img: ImageBuffer, params: RenderTexture.Params): RenderTexture | undefined {
    return this.createTexture(params, TextureHandle.createForImageBuffer(img, params.type));
  }

  private createTextureFromImage(image: HTMLImageElement, hasAlpha: boolean, params: RenderTexture.Params): RenderTexture | undefined {
    return this.createTexture(params, TextureHandle.createForImage(image, hasAlpha, params.type));
  }

  private createTextureFromCubeImages(posX: HTMLImageElement, negX: HTMLImageElement, posY: HTMLImageElement, negY: HTMLImageElement, posZ: HTMLImageElement, negZ: HTMLImageElement, params: RenderTexture.Params) {
    return this.createTexture(params, TextureHandle.createForCubeImages(posX, negX, posY, negY, posZ, negZ));
  }

  public findTexture(key?: string): RenderTexture | undefined { return undefined !== key ? this.textures.get(key) : undefined; }

  /** Find or attempt to create a new texture using an ImageBuffer. If a new texture was created, it will be cached provided its key is valid. */
  public getTexture(img: ImageBuffer, params: RenderTexture.Params): RenderTexture | undefined {
    const tex = this.findTexture(params.key);
    return undefined !== tex ? tex : this.createTextureFromImageBuffer(img, params);
  }

  public getTextureFromImage(image: HTMLImageElement, hasAlpha: boolean, params: RenderTexture.Params): RenderTexture | undefined {
    const tex = this.findTexture(params.key);
    return undefined !== tex ? tex : this.createTextureFromImage(image, hasAlpha, params);
  }

  public getTextureFromCubeImages(posX: HTMLImageElement, negX: HTMLImageElement, posY: HTMLImageElement, negY: HTMLImageElement, posZ: HTMLImageElement, negZ: HTMLImageElement, params: RenderTexture.Params): RenderTexture | undefined {
    return this.createTextureFromCubeImages(posX, negX, posY, negY, posZ, negZ, params);
  }

  /** Find or attempt to create a new texture using gradient symbology. If a new texture was created, it will be cached using the gradient. */
  public getGradient(grad: Gradient.Symb): RenderTexture | undefined {
    const existingGrad = this.gradients.get(grad);
    if (existingGrad)
      return existingGrad;

    const image: ImageBuffer = grad.getImage(0x100, 0x100);

    const textureHandle = TextureHandle.createForImageBuffer(image, RenderTexture.Type.Normal);
    if (!textureHandle)
      return undefined;

    const params = new Texture.Params(undefined, Texture.Type.Normal, true); // gradient textures are unnamed, but owned by this IdMap.
    const texture = new Texture(params, textureHandle);
    this.addGradient(grad, texture);
    return texture;
  }

  /** Find or cache a new clipping volume using the given clip vector. */
  public getClipVolume(clipVector: ClipVector): RenderClipVolume | undefined {
    const existingClipVolume = this.clipVolumes.get(clipVector);
    if (existingClipVolume)
      return existingClipVolume;

    let clipVolume: RenderClipVolume | undefined = ClipMaskVolume.create(clipVector);
    if (clipVolume === undefined)
      clipVolume = ClipPlanesVolume.create(clipVector);
    if (clipVolume !== undefined)
      this.clipVolumes.set(clipVector, clipVolume);
    return clipVolume;
  }
}

class TextureStats implements TextureMonitor {
  private _allocated = new Set<TextureHandle>();
  private _maxSize = 0;

  public onTextureCreated(tex: TextureHandle): void {
    assert(!this._allocated.has(tex));
    const size = tex.width * tex.height;
    this._maxSize = Math.max(size, this._maxSize);
    this._allocated.add(tex);
  }

  public onTextureDisposed(tex: TextureHandle): void {
    assert(this._allocated.has(tex));
    this._allocated.delete(tex);
    const thisSize = tex.width * tex.height;
    if (thisSize < this._maxSize)
      return;

    this._maxSize = 0;
    for (const entry of this._allocated)
      this._maxSize = Math.max(this._maxSize, entry.width * entry.height);
  }
}

export type TextureBinding = WebGLTexture | undefined;

const enum VertexAttribState {
  Disabled = 0,
  Enabled = 1 << 0,
  Instanced = 1 << 2,
  InstancedEnabled = Instanced | Enabled,
}

export class System extends RenderSystem {
  public readonly canvas: HTMLCanvasElement;
  public readonly currentRenderState = new RenderState();
  public readonly context: WebGLRenderingContext;
  public readonly frameBufferStack = new FrameBufferStack();  // frame buffers are not owned by the system
  public readonly capabilities: Capabilities;
  public readonly resourceCache: Map<IModelConnection, IdMap>;
  private readonly _drawBuffersExtension?: WEBGL_draw_buffers;
  private readonly _instancingExtension?: ANGLE_instanced_arrays;
  private readonly _textureStats?: TextureStats;
  private readonly _textureBindings: TextureBinding[] = [];

  // NB: Increase the size of these arrays when the maximum number of attributes used by any one shader increases.
  private readonly _curVertexAttribStates: VertexAttribState[] = [
    VertexAttribState.Disabled, VertexAttribState.Disabled, VertexAttribState.Disabled, VertexAttribState.Disabled,
    VertexAttribState.Disabled, VertexAttribState.Disabled, VertexAttribState.Disabled, VertexAttribState.Disabled,
    VertexAttribState.Disabled, VertexAttribState.Disabled, VertexAttribState.Disabled, VertexAttribState.Disabled,
  ];
  private readonly _nextVertexAttribStates: VertexAttribState[] = [
    VertexAttribState.Disabled, VertexAttribState.Disabled, VertexAttribState.Disabled, VertexAttribState.Disabled,
    VertexAttribState.Disabled, VertexAttribState.Disabled, VertexAttribState.Disabled, VertexAttribState.Disabled,
    VertexAttribState.Disabled, VertexAttribState.Disabled, VertexAttribState.Disabled, VertexAttribState.Disabled,
  ];

  // The following are initialized immediately after the System is constructed.
  private _lineCodeTexture?: TextureHandle;
  private _noiseTexture?: TextureHandle;
  private _techniques?: Techniques;

  public static get instance() { return IModelApp.renderSystem as System; }

  public get isValid(): boolean { return this.canvas !== undefined; }
  public get lineCodeTexture() { return this._lineCodeTexture; }
  public get noiseTexture() { return this._noiseTexture; }
  public get techniques() { return this._techniques!; }

  public get maxTextureSize(): number { return this.capabilities.maxTextureSize; }

  public setDrawBuffers(attachments: GLenum[]): void {
    // NB: The WEBGL_draw_buffers member is not exported directly because that type name is not available in some contexts (e.g. test-imodel-service).
    if (undefined !== this._drawBuffersExtension)
      this._drawBuffersExtension.drawBuffersWEBGL(attachments);
  }

  public static create(): System {
    const canvas = document.createElement("canvas") as HTMLCanvasElement;
    if (null === canvas)
      throw new IModelError(BentleyStatus.ERROR, "Failed to obtain HTMLCanvasElement");

    let context = canvas.getContext("webgl");
    if (null === context) {
      context = canvas.getContext("experimental-webgl"); // IE, Edge...
      if (null === context) {
        throw new IModelError(BentleyStatus.ERROR, "Failed to obtain WebGL context");
      }
    }

    const capabilities = Capabilities.create(context);
    if (undefined === capabilities)
      throw new IModelError(BentleyStatus.ERROR, "Failed to initialize rendering capabilities");

    return new System(canvas, context, capabilities);
  }

  // Note: FrameBuffers inside of the FrameBufferStack are not owned by the System, and are only used as a central storage device
  public dispose() {
    this._techniques = dispose(this._techniques);
    this._lineCodeTexture = dispose(this._lineCodeTexture);
    this._noiseTexture = dispose(this._noiseTexture);

    // We must attempt to dispose of each idmap in the resourceCache (if idmap is already disposed, has no effect)
    this.resourceCache.forEach((idMap: IdMap) => {
      dispose(idMap);
    });

    this.resourceCache.clear();
    IModelConnection.onClose.removeListener(this.removeIModelMap);
  }

  public onInitialized(): void {
    this._techniques = Techniques.create(this.context);

    const noiseDim = 4;
    const noiseArr = new Uint8Array([152, 235, 94, 173, 219, 215, 115, 176, 73, 205, 43, 201, 10, 81, 205, 198]);
    this._noiseTexture = TextureHandle.createForData(noiseDim, noiseDim, noiseArr, false, GL.Texture.WrapMode.Repeat, GL.Texture.Format.Luminance);
    assert(undefined !== this._noiseTexture, "System.noiseTexture not created.");

    this._lineCodeTexture = TextureHandle.createForData(LineCode.size, LineCode.count, new Uint8Array(LineCode.lineCodeData), false, GL.Texture.WrapMode.Repeat, GL.Texture.Format.Luminance);
    assert(undefined !== this._lineCodeTexture, "System.lineCodeTexture not created.");
  }

  public createTarget(canvas: HTMLCanvasElement): RenderTarget { return new OnScreenTarget(canvas); }
  public createOffscreenTarget(rect: ViewRect): RenderTarget { return new OffScreenTarget(rect); }
  public createGraphicBuilder(placement: Transform, type: GraphicType, viewport: Viewport, pickableId?: Id64String): GraphicBuilder { return new PrimitiveBuilder(this, type, viewport, placement, pickableId); }

  public createMesh(params: MeshParams, instances?: InstancedGraphicParams): RenderGraphic | undefined { return MeshGraphic.create(params, instances); }
  public createPolyline(params: PolylineParams, instances?: InstancedGraphicParams): RenderGraphic | undefined { return Primitive.create(() => PolylineGeometry.create(params), instances); }
  public createPointString(params: PointStringParams, instances?: InstancedGraphicParams): RenderGraphic | undefined { return Primitive.create(() => PointStringGeometry.create(params), instances); }
  public createPointCloud(args: PointCloudArgs): RenderGraphic | undefined { return Primitive.create(() => new PointCloudGeometry(args)); }

  public createGraphicList(primitives: RenderGraphic[]): RenderGraphic { return new GraphicsArray(primitives); }
  public createBranch(branch: GraphicBranch, transform: Transform, clips?: ClipPlanesVolume | ClipMaskVolume): RenderGraphic { return new Branch(branch, transform, clips); }
  public createBatch(graphic: RenderGraphic, features: PackedFeatureTable, range: ElementAlignedBox3d): RenderGraphic { return new Batch(graphic, features, range); }

  public createSkyBox(params: SkyBox.CreateParams): RenderGraphic | undefined {
    if (undefined !== params.cube) {
      return SkyBoxPrimitive.create(() => SkyBoxQuadsGeometry.create(params.cube!));
    } else {
      assert(undefined !== params.sphere || undefined !== params.gradient);
      return SkyBoxPrimitive.create(() => SkySphereViewportQuadGeometry.createGeometry(params));
    }
  }

  public applyRenderState(newState: RenderState) {
    newState.apply(this.currentRenderState);
    this.currentRenderState.copyFrom(newState);
  }

  public createDepthBuffer(width: number, height: number): DepthBuffer | undefined {
    // Note: The buffer/texture created here have ownership passed to the caller (system will not dispose of these)
    switch (this.capabilities.maxDepthType) {
      case DepthType.RenderBufferUnsignedShort16: {
        return RenderBuffer.create(width, height);
      }
      case DepthType.TextureUnsignedInt32: {
        return TextureHandle.createForAttachment(width, height, GL.Texture.Format.DepthComponent, GL.Texture.DataType.UnsignedInt);
      }
      case DepthType.TextureUnsignedInt24Stencil8: {
        const dtExt: WEBGL_depth_texture | undefined = this.capabilities.queryExtensionObject<WEBGL_depth_texture>("WEBGL_depth_texture");
        return TextureHandle.createForAttachment(width, height, GL.Texture.Format.DepthStencil, dtExt!.UNSIGNED_INT_24_8_WEBGL);
      }
      default: {
        assert(false);
        return undefined;
      }
    }
  }

  /** Returns the corresponding IdMap for an IModelConnection. Creates a new one if it doesn't exist. */
  public createIModelMap(imodel: IModelConnection): IdMap {
    let idMap = this.resourceCache.get(imodel);
    if (!idMap) {
      idMap = new IdMap();
      this.resourceCache.set(imodel, idMap);
    }
    return idMap;
  }

  /** Removes an IModelConnection-IdMap pairing from the system's resource cache. */
  private removeIModelMap(imodel: IModelConnection) {
    const idMap = this.resourceCache.get(imodel);
    if (idMap === undefined)
      return;
    dispose(idMap);
    this.resourceCache.delete(imodel);
  }

  /** Attempt to create a material for the given iModel using a set of material parameters. */
  public createMaterial(params: RenderMaterial.Params, imodel: IModelConnection): RenderMaterial | undefined {
    const idMap = this.getIdMap(imodel);
    const material = idMap.getMaterial(params);
    return material;
  }

  /** Using its key, search for an existing material of an open iModel. */
  public findMaterial(key: string, imodel: IModelConnection): RenderMaterial | undefined {
    const idMap = this.resourceCache.get(imodel);
    if (!idMap)
      return undefined;
    return idMap.findMaterial(key);
  }

  /** Attempt to create a texture for the given iModel using an ImageBuffer. */
  public createTextureFromImageBuffer(image: ImageBuffer, imodel: IModelConnection, params: RenderTexture.Params): RenderTexture | undefined {
    return this.getIdMap(imodel).getTexture(image, params);
  }

  /** Attempt to create a texture for the given iModel using an HTML image element. */
  public createTextureFromImage(image: HTMLImageElement, hasAlpha: boolean, imodel: IModelConnection | undefined, params: RenderTexture.Params): RenderTexture | undefined {
    // if imodel is undefined, caller is responsible for disposing texture. It will not be associated with an IModelConnection
    if (undefined === imodel) {
      const textureHandle = TextureHandle.createForImage(image, hasAlpha, params.type);
      return undefined !== textureHandle ? new Texture(params, textureHandle) : undefined;
    }

    return this.getIdMap(imodel).getTextureFromImage(image, hasAlpha, params);
  }

  /** Attempt to create a texture from a cube of HTML images. */
  public createTextureFromCubeImages(posX: HTMLImageElement, negX: HTMLImageElement, posY: HTMLImageElement, negY: HTMLImageElement, posZ: HTMLImageElement, negZ: HTMLImageElement, imodel: IModelConnection, params: RenderTexture.Params): RenderTexture | undefined {
    return this.getIdMap(imodel).getTextureFromCubeImages(posX, negX, posY, negY, posZ, negZ, params);
  }

  /** Attempt to create a texture using gradient symbology. */
  public getGradientTexture(symb: Gradient.Symb, imodel: IModelConnection): RenderTexture | undefined {
    const idMap = this.getIdMap(imodel);
    const texture = idMap.getGradient(symb);
    return texture;
  }

  /** Using its key, search for an existing texture of an open iModel. */
  public findTexture(key: string, imodel: IModelConnection): RenderTexture | undefined {
    const idMap = this.resourceCache.get(imodel);
    if (!idMap)
      return undefined;
    return idMap.findTexture(key);
  }

  /** Attempt to create a clipping volume for the given iModel using a clip vector. */
  public getClipVolume(clipVector: ClipVector, imodel: IModelConnection): RenderClipVolume | undefined {
    const idMap = this.getIdMap(imodel);
    return idMap.getClipVolume(clipVector);
  }

  private constructor(canvas: HTMLCanvasElement, context: WebGLRenderingContext, capabilities: Capabilities) {
    super();
    this.canvas = canvas;
    this.context = context;
    this.capabilities = capabilities;
    this._drawBuffersExtension = capabilities.queryExtensionObject<WEBGL_draw_buffers>("WEBGL_draw_buffers");
    this._instancingExtension = capabilities.queryExtensionObject<ANGLE_instanced_arrays>("ANGLE_instanced_arrays");
    this.resourceCache = new Map<IModelConnection, IdMap>();

    // Make this System a subscriber to the the IModelConnection onClose event
    IModelConnection.onClose.addListener(this.removeIModelMap.bind(this));

    if (debugTextureLifetime) {
      this._textureStats = new TextureStats();
      TextureHandle.monitor = this._textureStats;
    }
  }

  private getIdMap(imodel: IModelConnection): IdMap {
    const map = this.resourceCache.get(imodel);
    return undefined !== map ? map : this.createIModelMap(imodel);
  }

  public createSheetTilePolyfaces(corners: Point3d[], clip?: ClipVector): IndexedPolyface[] {
    const sheetTilePolys: IndexedPolyface[] = [];

    // Texture params for this sheet tile will always go from (0,0) to (1,1). However, we may be dealing with a tile that is a sub-division. Store the
    // lower-left corner to subtract from point values later to get UV params.
    const sheetTileRange = Range3d.createArray(corners);
    const sheetTileScale = 1 / (sheetTileRange.high.x - sheetTileRange.low.x);
    const sheetTileOrigin = sheetTileRange.low;

    let clippedPolygons: Point3d[][];
    if (clip !== undefined)
      clippedPolygons = ClipUtilities.clipPolygonToClipShape(corners, clip.clips[0]); // ###TODO: Currently assume that there is only one shape...
    else
      clippedPolygons = [corners];

    if (clippedPolygons.length === 0)
      return sheetTilePolys;    // return empty

    // The result of clipping will be several polygons, which may lie next to each other, or be detached, and can be of any length. Let's stitch these into a single polyface.
    const strokeOptions = new StrokeOptions();
    strokeOptions.needParams = true;
    strokeOptions.shouldTriangulate = true;
    const polyfaceBuilder = PolyfaceBuilder.create(strokeOptions);

    for (const polygon of clippedPolygons) {
      if (polygon.length < 3)
        continue;
      else if (polygon.length === 3) {
        const params: Point2d[] = [];
        for (const point of polygon) {
          const paramUnscaled = point.minus(sheetTileOrigin);
          params.push(Point2d.create(paramUnscaled.x * sheetTileScale, paramUnscaled.y * sheetTileScale));
        }
        polyfaceBuilder.addTriangleFacet(polygon, params);

      } else if (polygon.length === 4) {
        const params: Point2d[] = [];
        for (const point of polygon) {
          const paramUnscaled = point.minus(sheetTileOrigin);
          params.push(Point2d.create(paramUnscaled.x * sheetTileScale, paramUnscaled.y * sheetTileScale));
        }
        polyfaceBuilder.addQuadFacet(polygon, params);

      } else {
        // ### TODO: There are a lot of inefficiencies here (what if it is a simple convex polygon... we must adjust UV params ourselves afterwards, a PolyfaceVisitor....)
        // We are also assuming that when we use the polyface visitor, it will iterate over the points in order of the entire array
        const triangulatedPolygon = Triangulator.createTriangulatedGraphFromSingleLoop(polygon);
        Triangulator.flipTriangles(triangulatedPolygon);

        triangulatedPolygon.announceFaceLoops((_graph: HalfEdgeGraph, edge: HalfEdge): boolean => {
          if (!edge.isMaskSet(HalfEdgeMask.EXTERIOR)) {
            const trianglePoints: Point3d[] = [];
            const params: Point2d[] = [];

            edge.collectAroundFace((node: HalfEdge) => {
              const point = Point3d.create(node.x, node.y, 0.5);
              trianglePoints.push(point);
              const paramUnscaled = point.minus(sheetTileOrigin);
              params.push(Point2d.create(paramUnscaled.x * sheetTileScale, paramUnscaled.y * sheetTileScale));
            });

            assert(trianglePoints.length === 3);
            polyfaceBuilder.addTriangleFacet(trianglePoints, params);
          }
          return true;
        });
      }
    }

    sheetTilePolys.push(polyfaceBuilder.claimPolyface());
    return sheetTilePolys;
  }

  public createSheetTile(tile: RenderTexture, polyfaces: IndexedPolyface[], tileColor: ColorDef): GraphicList {
    const sheetTileGraphics: GraphicList = [];

    for (const polyface of polyfaces) {
      const rawParams = polyface.data.param;
      if (rawParams === undefined)
        return sheetTileGraphics;   // return empty

      const meshArgs = new MeshArgs();
      const pts = polyface.data.point.getPoint3dArray();

      meshArgs.points = new QPoint3dList(QParams3d.fromRange(Range3d.createArray(pts)));  // use these point params
      for (const point of pts)
        meshArgs.points.push(QPoint3d.create(point, meshArgs.points.params));

      const uvs: Point2d[] = rawParams.getPoint2dArray();

      const pointIndices: number[] = [];
      const uvIndices: number[] = [];
      const visitor = IndexedPolyfaceVisitor.create(polyface, 0);
      while (visitor.moveToNextFacet()) {
        for (let i = 0; i < 3; i++) {
          pointIndices.push(visitor.clientPointIndex(i));
          uvIndices.push(visitor.clientParamIndex(i));
        }
      }

      // make uv arrangement and indices match that of points
      // this is necessary because MeshArgs assumes vertIndices refers to both points and UVs
      // output uvsOut to clippedTile
      let j = 0;
      const uvsOut: Point2d[] = [];
      for (const pointIdx of pointIndices)
        uvsOut[pointIdx] = uvs[uvIndices[j++]];   // passing the reference should not matter

      meshArgs.textureUv = uvsOut;
      meshArgs.vertIndices = pointIndices;
      meshArgs.texture = tile;
      meshArgs.material = undefined;
      meshArgs.isPlanar = true;
      meshArgs.colors.initUniform(tileColor);

      const mesh = this.createTriMesh(meshArgs);
      if (mesh !== undefined)
        sheetTileGraphics.push(mesh);
    }

    return sheetTileGraphics;
  }

  private bindTexture(unit: TextureUnit, target: GL.Texture.Target, texture: TextureBinding): void {
    const index = unit - TextureUnit.Zero;
    if (this._textureBindings[index] === texture)
      return;

    this._textureBindings[index] = texture;
    this.context.activeTexture(unit);
    this.context.bindTexture(target, undefined !== texture ? texture : null);
  }

  public bindTexture2d(unit: TextureUnit, texture: TextureBinding) { this.bindTexture(unit, GL.Texture.Target.TwoDee, texture); }
  public bindTextureCubeMap(unit: TextureUnit, texture: TextureBinding) { this.bindTexture(unit, GL.Texture.Target.CubeMap, texture); }

  // Ensure *something* is bound to suppress 'no texture assigned to unit x' warnings.
  public ensureSamplerBound(uniform: UniformHandle, unit: TextureUnit): void {
    this.lineCodeTexture!.bindSampler(uniform, unit);
  }

  public disposeTexture(texture: WebGLTexture) {
    System.instance.context.deleteTexture(texture);
    for (let i = 0; i < this._textureBindings.length; i++) {
      if (this._textureBindings[i] === texture) {
        this._textureBindings[i] = undefined;
        break;
      }
    }
  }

  // System keeps track of current enabled state of vertex attribute arrays.
  // This prevents errors caused by leaving a vertex attrib array enabled after disposing of the buffer bound to it;
  // also prevents unnecessarily 'updating' the enabled state of a vertex attrib array when it hasn't actually changed.
  public enableVertexAttribArray(id: number, instanced: boolean): void {
    assert(id < this._nextVertexAttribStates.length, "if you add new vertex attributes you must update array length");
    assert(id < this._curVertexAttribStates.length, "if you add new vertex attributes you must update array length");

    this._nextVertexAttribStates[id] = instanced ? VertexAttribState.InstancedEnabled : VertexAttribState.Enabled;
  }

  public updateVertexAttribArrays(): void {
    const cur = this._curVertexAttribStates;
    const next = this._nextVertexAttribStates;
    const context = this.context;

    for (let i = 0; i < next.length; i++) {
      const oldState = cur[i];
      const newState = next[i];
      if (oldState !== newState) {
        // Update the enabled state if it changed.
        const wasEnabled = 0 !== (VertexAttribState.Enabled & oldState);
        const nowEnabled = 0 !== (VertexAttribState.Enabled & newState);
        if (wasEnabled !== nowEnabled) {
          if (nowEnabled) {
            context.enableVertexAttribArray(i);
          } else {
            context.disableVertexAttribArray(i);
          }
        }

        // Only update the divisor if the attribute is enabled.
        if (nowEnabled) {
          const wasInstanced = 0 !== (VertexAttribState.Instanced & oldState);
          const nowInstanced = 0 !== (VertexAttribState.Instanced & newState);
          if (wasInstanced !== nowInstanced) {
            assert(undefined !== this._instancingExtension);
            this._instancingExtension!.vertexAttribDivisorANGLE(i, nowInstanced ? 1 : 0);
          }
        }

        cur[i] = newState;
      }

      // Set the attribute back to disabled, but preserve the divisor.
      next[i] &= ~VertexAttribState.Enabled;
    }
  }

  public drawArrays(type: GL.PrimitiveType, first: number, count: number, numInstances: number): void {
    if (0 !== numInstances) {
      if (undefined !== this._instancingExtension)
        this._instancingExtension.drawArraysInstancedANGLE(type, first, count, numInstances);
    } else {
      this.context.drawArrays(type, first, count);
    }
  }

  public enableDiagnostics(enable: RenderDiagnostics): void {
    Debug.printEnabled = RenderDiagnostics.None !== (enable & RenderDiagnostics.DebugOutput);
    Debug.evaluateEnabled = RenderDiagnostics.None !== (enable & RenderDiagnostics.WebGL);
  }
}
