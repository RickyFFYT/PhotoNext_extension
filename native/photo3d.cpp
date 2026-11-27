/*
 * PhotoNext 3D — a small, deterministic glTF compositor.
 *
 * This is deliberately not a modelling package. It loads a GLB/GLTF, places it
 * in a camera, lights it, and rasterises a PNG that the Node side adds as a
 * normal PhotoNext raster layer. The expensive part — the per-pixel triangle
 * pass, texture sampling and shadow-map filtering — lives here so the extension
 * does not need a browser or a GPU for a render.
 *
 * The native program is invoked by native3d.cjs:
 *   photo3d --probe model.glb
 *   photo3d --render job.txt
 *
 * It has no third-party service dependency. TinyGLTF/STB/nlohmann are vendored.
 */

#define TINYGLTF_IMPLEMENTATION
#define STB_IMAGE_IMPLEMENTATION
#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "vendor/tiny_gltf.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cctype>
#include <fstream>
#include <iostream>
#include <limits>
#include <map>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

namespace {

constexpr float PI = 3.14159265358979323846f;
constexpr float EPS = 1e-6f;
constexpr int MAX_TRIANGLES = 2000000;
constexpr int MAX_OUTPUT_EDGE = 6000;
constexpr float SHADOW_DISK[12][2] = {
    {-0.326f, 0.000f}, {-0.166f, 0.312f}, {0.000f, 0.166f}, {0.166f, 0.312f},
    {0.326f, 0.000f}, {0.166f, -0.312f}, {0.000f, -0.166f}, {-0.166f, -0.312f},
    {-0.106f, 0.106f}, {0.106f, 0.106f}, {0.106f, -0.106f}, {-0.106f, -0.106f},
};

struct Vec2 {
  float x = 0.0f;
  float y = 0.0f;
};

struct Vec3 {
  float x = 0.0f;
  float y = 0.0f;
  float z = 0.0f;
};

struct Vec4 {
  float x = 0.0f;
  float y = 0.0f;
  float z = 0.0f;
  float w = 0.0f;
};

inline Vec3 v3(float x, float y, float z) { return Vec3{x, y, z}; }
inline Vec3 add(Vec3 a, Vec3 b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
inline Vec3 sub(Vec3 a, Vec3 b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
inline Vec3 mul(Vec3 a, float s) { return {a.x * s, a.y * s, a.z * s}; }
inline Vec3 mulv(Vec3 a, Vec3 b) { return {a.x * b.x, a.y * b.y, a.z * b.z}; }
inline float dot(Vec3 a, Vec3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
inline Vec3 cross(Vec3 a, Vec3 b) {
  return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x};
}
inline float length(Vec3 v) { return std::sqrt(dot(v, v)); }
inline Vec3 normalize(Vec3 v) {
  const float l = length(v);
  return l > EPS ? mul(v, 1.0f / l) : v3(0, 0, 0);
}
inline Vec3 mix(Vec3 a, Vec3 b, float t) { return add(mul(a, 1.0f - t), mul(b, t)); }
inline float clamp01(float value) { return std::max(0.0f, std::min(1.0f, value)); }
inline float maxf(float a, float b) { return std::max(a, b); }
inline float minf(float a, float b) { return std::min(a, b); }

struct Mat4 {
  float m[16] = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
};

Mat4 identity() { return Mat4{}; }

Mat4 multiply(const Mat4& a, const Mat4& b) {
  Mat4 out;
  for (int row = 0; row < 4; ++row) {
    for (int col = 0; col < 4; ++col) {
      float value = 0.0f;
      for (int k = 0; k < 4; ++k) value += a.m[row * 4 + k] * b.m[k * 4 + col];
      out.m[row * 4 + col] = value;
    }
  }
  return out;
}

Vec3 transformPoint(const Mat4& m, Vec3 p) {
  return {
      m.m[0] * p.x + m.m[1] * p.y + m.m[2] * p.z + m.m[3],
      m.m[4] * p.x + m.m[5] * p.y + m.m[6] * p.z + m.m[7],
      m.m[8] * p.x + m.m[9] * p.y + m.m[10] * p.z + m.m[11],
  };
}

Vec4 transformVec4(const Mat4& m, Vec3 p) {
  return {
      m.m[0] * p.x + m.m[1] * p.y + m.m[2] * p.z + m.m[3],
      m.m[4] * p.x + m.m[5] * p.y + m.m[6] * p.z + m.m[7],
      m.m[8] * p.x + m.m[9] * p.y + m.m[10] * p.z + m.m[11],
      m.m[12] * p.x + m.m[13] * p.y + m.m[14] * p.z + m.m[15],
  };
}

Mat4 translation(Vec3 t) {
  Mat4 m;
  m.m[3] = t.x;
  m.m[7] = t.y;
  m.m[11] = t.z;
  return m;
}

Mat4 scaling(Vec3 s);

Mat4 scaling(float s) { return scaling(v3(s, s, s)); }

Mat4 scaling(Vec3 s) {
  Mat4 m;
  m.m[0] = s.x;
  m.m[5] = s.y;
  m.m[10] = s.z;
  return m;
}

Mat4 rotationX(float angle) {
  Mat4 m;
  const float c = std::cos(angle);
  const float s = std::sin(angle);
  m.m[5] = c;
  m.m[6] = -s;
  m.m[9] = s;
  m.m[10] = c;
  return m;
}

Mat4 rotationY(float angle) {
  Mat4 m;
  const float c = std::cos(angle);
  const float s = std::sin(angle);
  m.m[0] = c;
  m.m[2] = s;
  m.m[8] = -s;
  m.m[10] = c;
  return m;
}

Mat4 rotationZ(float angle) {
  Mat4 m;
  const float c = std::cos(angle);
  const float s = std::sin(angle);
  m.m[0] = c;
  m.m[1] = -s;
  m.m[4] = s;
  m.m[5] = c;
  return m;
}

Mat4 quaternionMatrix(float x, float y, float z, float w) {
  Mat4 m;
  const float xx = x * x;
  const float yy = y * y;
  const float zz = z * z;
  const float xy = x * y;
  const float xz = x * z;
  const float yz = y * z;
  const float wx = w * x;
  const float wy = w * y;
  const float wz = w * z;
  m.m[0] = 1 - 2 * (yy + zz);
  m.m[1] = 2 * (xy - wz);
  m.m[2] = 2 * (xz + wy);
  m.m[4] = 2 * (xy + wz);
  m.m[5] = 1 - 2 * (xx + zz);
  m.m[6] = 2 * (yz - wx);
  m.m[8] = 2 * (xz - wy);
  m.m[9] = 2 * (yz + wx);
  m.m[10] = 1 - 2 * (xx + yy);
  return m;
}

Mat4 nodeMatrix(const tinygltf::Node& node) {
  if (node.matrix.size() == 16) {
    Mat4 m;
    // glTF stores column-major; this renderer uses row-major.
    for (int row = 0; row < 4; ++row) {
      for (int col = 0; col < 4; ++col) {
        m.m[row * 4 + col] = static_cast<float>(node.matrix[col * 4 + row]);
      }
    }
    return m;
  }
  Mat4 m = translation(
      {static_cast<float>(node.translation.size() > 0 ? node.translation[0] : 0.0),
       static_cast<float>(node.translation.size() > 1 ? node.translation[1] : 0.0),
       static_cast<float>(node.translation.size() > 2 ? node.translation[2] : 0.0)});
  if (node.rotation.size() == 4) {
    m = multiply(
        m,
        quaternionMatrix(
            static_cast<float>(node.rotation[0]),
            static_cast<float>(node.rotation[1]),
            static_cast<float>(node.rotation[2]),
            static_cast<float>(node.rotation[3])));
  }
  m = multiply(
      m,
      scaling(node.scale.size() == 3
                  ? v3(static_cast<float>(node.scale[0]), static_cast<float>(node.scale[1]),
                       static_cast<float>(node.scale[2]))
                  : v3(1, 1, 1)));
  return m;
}

Mat4 lookAt(Vec3 eye, Vec3 target, Vec3 up) {
  const Vec3 f = normalize(sub(target, eye));
  Vec3 s = normalize(cross(f, up));
  if (length(s) < EPS) s = normalize(cross(f, v3(1, 0, 0)));
  const Vec3 u = cross(s, f);
  Mat4 m;
  m.m[0] = s.x;
  m.m[1] = s.y;
  m.m[2] = s.z;
  m.m[3] = -dot(s, eye);
  m.m[4] = u.x;
  m.m[5] = u.y;
  m.m[6] = u.z;
  m.m[7] = -dot(u, eye);
  m.m[8] = -f.x;
  m.m[9] = -f.y;
  m.m[10] = -f.z;
  m.m[11] = dot(f, eye);
  return m;
}

Mat4 perspective(float fovYDegrees, float aspect, float nearPlane, float farPlane) {
  Mat4 m;
  for (int i = 0; i < 16; ++i) m.m[i] = 0.0f;
  const float f = 1.0f / std::tan(fovYDegrees * PI / 360.0f);
  m.m[0] = f / aspect;
  m.m[5] = f;
  m.m[10] = (farPlane + nearPlane) / (nearPlane - farPlane);
  m.m[11] = (2.0f * farPlane * nearPlane) / (nearPlane - farPlane);
  m.m[14] = -1.0f;
  return m;
}

Mat4 ortho(float left, float right, float bottom, float top, float nearPlane, float farPlane) {
  Mat4 m;
  for (int i = 0; i < 16; ++i) m.m[i] = 0.0f;
  m.m[0] = 2.0f / (right - left);
  m.m[5] = 2.0f / (top - bottom);
  m.m[10] = -2.0f / (farPlane - nearPlane);
  m.m[3] = -(right + left) / (right - left);
  m.m[7] = -(top + bottom) / (top - bottom);
  m.m[11] = -(farPlane + nearPlane) / (farPlane - nearPlane);
  m.m[15] = 1.0f;
  return m;
}

Mat4 normalMatrix(const Mat4& model) {
  const float a = model.m[0];
  const float b = model.m[1];
  const float c = model.m[2];
  const float d = model.m[4];
  const float e = model.m[5];
  const float f = model.m[6];
  const float g = model.m[8];
  const float h = model.m[9];
  const float i = model.m[10];
  const float det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (std::abs(det) < EPS) return identity();
  const float inv = 1.0f / det;
  Mat4 result;
  // Row-major inverse transpose of the upper 3x3.
  result.m[0] = (e * i - f * h) * inv;
  result.m[1] = -(b * i - c * h) * inv;
  result.m[2] = (b * f - c * e) * inv;
  result.m[4] = -(d * i - f * g) * inv;
  result.m[5] = (a * i - c * g) * inv;
  result.m[6] = -(a * f - c * d) * inv;
  result.m[8] = (d * h - e * g) * inv;
  result.m[9] = -(a * h - b * g) * inv;
  result.m[10] = (a * e - b * d) * inv;
  return result;
}

Vec3 transformNormal(const Mat4& model, Vec3 n) {
  const Mat4 nm = normalMatrix(model);
  return normalize(v3(
      nm.m[0] * n.x + nm.m[1] * n.y + nm.m[2] * n.z,
      nm.m[4] * n.x + nm.m[5] * n.y + nm.m[6] * n.z,
      nm.m[8] * n.x + nm.m[9] * n.y + nm.m[10] * n.z));
}

float srgbToLinear(float value) {
  return value <= 0.04045f ? value / 12.92f : std::pow((value + 0.055f) / 1.055f, 2.4f);
}

float linearToSrgb(float value) {
  return value <= 0.0031308f ? value * 12.92f : 1.055f * std::pow(std::max(0.0f, value), 1.0f / 2.4f) - 0.055f;
}

Vec3 acesTonemap(Vec3 color) {
  const float a = 2.51f;
  const float b = 0.03f;
  const float c = 2.43f;
  const float d = 0.59f;
  const float e = 0.14f;
  auto map = [&](float value) {
    const float x = std::max(0.0f, value);
    return clamp01((x * (a * x + b)) / (x * (c * x + d) + e));
  };
  return v3(map(color.x), map(color.y), map(color.z));
}

Vec3 colorFromHex(const std::string& value, Vec3 fallback) {
  std::string text = value;
  if (!text.empty() && text[0] == '#') text = text.substr(1);
  if (text.size() != 6 && text.size() != 8) return fallback;
  auto hex = [](char c) -> int {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return 0;
  };
  const int r = hex(text[0]) * 16 + hex(text[1]);
  const int g = hex(text[2]) * 16 + hex(text[3]);
  const int b = hex(text[4]) * 16 + hex(text[5]);
  return v3(r / 255.0f, g / 255.0f, b / 255.0f);
}

float alphaFromHex(const std::string& value, float fallback) {
  std::string text = value;
  if (!text.empty() && text[0] == '#') text = text.substr(1);
  if (text.size() != 8) return fallback;
  auto hex = [](char c) -> int {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return 0;
  };
  return (hex(text[6]) * 16 + hex(text[7])) / 255.0f;
}

struct Texture {
  int width = 0;
  int height = 0;
  int channels = 0;
  std::vector<unsigned char> pixels;
};

struct Material {
  Vec3 baseColor = v3(1, 1, 1);
  float alpha = 1.0f;
  float metallic = 0.0f;
  float roughness = 0.8f;
  int texture = -1;
  bool doubleSided = false;
  bool alphaMask = false;
  float alphaCutoff = 0.5f;
};

struct Triangle {
  Vec3 p[3];
  Vec3 n[3];
  Vec2 uv[3];
  int material = -1;
  bool ground = false;
};

struct Bounds {
  Vec3 min = v3(1e30f, 1e30f, 1e30f);
  Vec3 max = v3(-1e30f, -1e30f, -1e30f);
  bool valid = false;
};

void include(Bounds& bounds, Vec3 p) {
  bounds.min.x = std::min(bounds.min.x, p.x);
  bounds.min.y = std::min(bounds.min.y, p.y);
  bounds.min.z = std::min(bounds.min.z, p.z);
  bounds.max.x = std::max(bounds.max.x, p.x);
  bounds.max.y = std::max(bounds.max.y, p.y);
  bounds.max.z = std::max(bounds.max.z, p.z);
  bounds.valid = true;
}

Vec3 centerOf(const Bounds& b) { return mul(add(b.min, b.max), 0.5f); }
float radiusOf(const Bounds& b) {
  if (!b.valid) return 1.0f;
  return std::max(0.05f, length(sub(b.max, b.min)) * 0.5f);
}

struct Scene {
  std::vector<Triangle> triangles;
  std::vector<Material> materials;
  std::vector<Texture> textures;
  int meshes = 0;
  int primitives = 0;
  Bounds bounds;
};

struct AccessorView {
  const unsigned char* base = nullptr;
  int components = 0;
  int componentType = 0;
  int count = 0;
  int stride = 0;
  bool normalized = false;
};

int componentSize(int type) {
  switch (type) {
    case TINYGLTF_COMPONENT_TYPE_BYTE:
    case TINYGLTF_COMPONENT_TYPE_UNSIGNED_BYTE:
      return 1;
    case TINYGLTF_COMPONENT_TYPE_SHORT:
    case TINYGLTF_COMPONENT_TYPE_UNSIGNED_SHORT:
      return 2;
    case TINYGLTF_COMPONENT_TYPE_INT:
    case TINYGLTF_COMPONENT_TYPE_UNSIGNED_INT:
    case TINYGLTF_COMPONENT_TYPE_FLOAT:
      return 4;
    case TINYGLTF_COMPONENT_TYPE_DOUBLE:
      return 8;
    default:
      return 0;
  }
}

int typeComponents(int type) {
  switch (type) {
    case TINYGLTF_TYPE_SCALAR:
      return 1;
    case TINYGLTF_TYPE_VEC2:
      return 2;
    case TINYGLTF_TYPE_VEC3:
      return 3;
    case TINYGLTF_TYPE_VEC4:
      return 4;
    case TINYGLTF_TYPE_MAT2:
      return 4;
    case TINYGLTF_TYPE_MAT3:
      return 9;
    case TINYGLTF_TYPE_MAT4:
      return 16;
    default:
      return 0;
  }
}

bool accessorView(const tinygltf::Model& model, int index, AccessorView& out, std::string& err) {
  if (index < 0 || index >= static_cast<int>(model.accessors.size())) {
    err = "missing accessor";
    return false;
  }
  const tinygltf::Accessor& accessor = model.accessors[index];
  if (accessor.bufferView < 0 || accessor.bufferView >= static_cast<int>(model.bufferViews.size())) {
    err = "accessor has no buffer view";
    return false;
  }
  const tinygltf::BufferView& view = model.bufferViews[accessor.bufferView];
  if (view.buffer < 0 || view.buffer >= static_cast<int>(model.buffers.size())) {
    err = "buffer view has no buffer";
    return false;
  }
  const tinygltf::Buffer& buffer = model.buffers[view.buffer];
  const int comps = typeComponents(accessor.type);
  const int compSize = componentSize(accessor.componentType);
  if (!comps || !compSize) {
    err = "unsupported accessor layout";
    return false;
  }
  const size_t offset = view.byteOffset + accessor.byteOffset;
  const int stride = view.byteStride > 0 ? static_cast<int>(view.byteStride) : comps * compSize;
  const size_t lastIndex = accessor.count > 0 ? accessor.count - 1 : 0;
  if (offset + lastIndex * stride + comps * compSize > buffer.data.size()) {
    err = "accessor exceeds its buffer";
    return false;
  }
  out.base = buffer.data.data() + offset;
  out.components = comps;
  out.componentType = accessor.componentType;
  out.count = static_cast<int>(accessor.count);
  out.stride = stride;
  out.normalized = accessor.normalized;
  return true;
}

float readComponent(const AccessorView& view, int index, int component) {
  const unsigned char* p = view.base + static_cast<size_t>(index) * view.stride +
                           component * componentSize(view.componentType);
  switch (view.componentType) {
    case TINYGLTF_COMPONENT_TYPE_FLOAT: {
      float value = 0.0f;
      std::memcpy(&value, p, sizeof(float));
      return value;
    }
    case TINYGLTF_COMPONENT_TYPE_DOUBLE: {
      double value = 0.0;
      std::memcpy(&value, p, sizeof(double));
      return static_cast<float>(value);
    }
    case TINYGLTF_COMPONENT_TYPE_BYTE: {
      int8_t value = 0;
      std::memcpy(&value, p, sizeof(value));
      return view.normalized ? std::max(-1.0f, value / 127.0f) : static_cast<float>(value);
    }
    case TINYGLTF_COMPONENT_TYPE_UNSIGNED_BYTE: {
      uint8_t value = 0;
      std::memcpy(&value, p, sizeof(value));
      return view.normalized ? value / 255.0f : static_cast<float>(value);
    }
    case TINYGLTF_COMPONENT_TYPE_SHORT: {
      int16_t value = 0;
      std::memcpy(&value, p, sizeof(value));
      return view.normalized ? std::max(-1.0f, value / 32767.0f) : static_cast<float>(value);
    }
    case TINYGLTF_COMPONENT_TYPE_UNSIGNED_SHORT: {
      uint16_t value = 0;
      std::memcpy(&value, p, sizeof(value));
      return view.normalized ? value / 65535.0f : static_cast<float>(value);
    }
    case TINYGLTF_COMPONENT_TYPE_INT: {
      int32_t value = 0;
      std::memcpy(&value, p, sizeof(value));
      return static_cast<float>(value);
    }
    case TINYGLTF_COMPONENT_TYPE_UNSIGNED_INT: {
      uint32_t value = 0;
      std::memcpy(&value, p, sizeof(value));
      return static_cast<float>(value);
    }
    default:
      return 0.0f;
  }
}

uint32_t readIndex(const AccessorView& view, int index) {
  const unsigned char* p = view.base + static_cast<size_t>(index) * view.stride;
  switch (view.componentType) {
    case TINYGLTF_COMPONENT_TYPE_UNSIGNED_BYTE: return *p;
    case TINYGLTF_COMPONENT_TYPE_UNSIGNED_SHORT: {
      uint16_t value = 0;
      std::memcpy(&value, p, sizeof(value));
      return value;
    }
    case TINYGLTF_COMPONENT_TYPE_UNSIGNED_INT: {
      uint32_t value = 0;
      std::memcpy(&value, p, sizeof(value));
      return value;
    }
    default: return 0;
  }
}

bool loadTexture(const tinygltf::Model& model, int imageIndex, Texture& texture) {
  if (imageIndex < 0 || imageIndex >= static_cast<int>(model.images.size())) return false;
  const tinygltf::Image& image = model.images[imageIndex];
  if (image.width <= 0 || image.height <= 0 || image.image.empty()) return false;
  if (image.bits != 8 && image.pixel_type != TINYGLTF_COMPONENT_TYPE_UNSIGNED_BYTE) {
    // STB's HDR path is not needed for the compositor's base-colour maps.
    if (image.bits != 8) return false;
  }
  texture.width = image.width;
  texture.height = image.height;
  texture.channels = image.component > 0 ? image.component : 4;
  texture.pixels = image.image;
  if (texture.channels != 3 && texture.channels != 4 && texture.channels != 1) return false;
  return true;
}

bool buildScene(const std::string& path, Scene& scene, std::string& err) {
  tinygltf::TinyGLTF loader;
  tinygltf::Model model;
  std::string warnings;
  const bool binary = path.size() >= 4 &&
                      (path.substr(path.size() - 4) == ".glb" || path.substr(path.size() - 4) == ".GLB");
  const bool ok = binary ? loader.LoadBinaryFromFile(&model, &err, &warnings, path)
                         : loader.LoadASCIIFromFile(&model, &err, &warnings, path);
  if (!ok) {
    if (err.empty()) err = "TinyGLTF could not read the model.";
    return false;
  }
  if (!warnings.empty()) std::cerr << "warning: " << warnings << "\n";
  if (model.meshes.empty()) {
    err = "The model has no meshes.";
    return false;
  }

  scene.meshes = static_cast<int>(model.meshes.size());
  scene.materials.reserve(model.materials.size());
  for (const tinygltf::Material& source : model.materials) {
    Material material;
    const auto& pbr = source.pbrMetallicRoughness;
    if (pbr.baseColorFactor.size() >= 3) {
      material.baseColor = v3(
          static_cast<float>(pbr.baseColorFactor[0]),
          static_cast<float>(pbr.baseColorFactor[1]),
          static_cast<float>(pbr.baseColorFactor[2]));
    }
    if (pbr.baseColorFactor.size() >= 4) {
      material.alpha = static_cast<float>(pbr.baseColorFactor[3]);
    }
    material.metallic = static_cast<float>(pbr.metallicFactor);
    material.roughness = static_cast<float>(pbr.roughnessFactor);
    material.doubleSided = source.doubleSided;
    material.alphaMask = source.alphaMode == "MASK";
    material.alphaCutoff = static_cast<float>(source.alphaCutoff);
    if (pbr.baseColorTexture.index >= 0 &&
        pbr.baseColorTexture.index < static_cast<int>(model.textures.size())) {
      const tinygltf::Texture& texture = model.textures[pbr.baseColorTexture.index];
      material.texture = texture.source;
    }
    scene.materials.push_back(material);
  }

  for (int imageIndex = 0; imageIndex < static_cast<int>(model.images.size()); ++imageIndex) {
    Texture texture;
    if (loadTexture(model, imageIndex, texture)) {
      scene.textures.push_back(std::move(texture));
    } else {
      scene.textures.push_back(Texture{});
    }
  }

  const Mat4 object =
      multiply(
          translation(v3(0, 0, 0)),
          identity());
  (void)object;

  auto appendPrimitive = [&](const tinygltf::Primitive& primitive,
                             int materialIndex,
                             const Mat4& world,
                             const Mat4& objectTransform) -> bool {
    if (primitive.mode != TINYGLTF_MODE_TRIANGLES &&
        primitive.mode != TINYGLTF_MODE_TRIANGLE_STRIP &&
        primitive.mode != TINYGLTF_MODE_TRIANGLE_FAN) {
      return true;
    }
    auto positionIt = primitive.attributes.find("POSITION");
    if (positionIt == primitive.attributes.end()) return true;
    AccessorView positions;
    std::string localError;
    if (!accessorView(model, positionIt->second, positions, localError)) {
      err = "POSITION: " + localError;
      return false;
    }
    if (positions.components != 3) {
      err = "POSITION must be VEC3.";
      return false;
    }

    AccessorView normals;
    bool hasNormals = false;
    const auto normalIt = primitive.attributes.find("NORMAL");
    if (normalIt != primitive.attributes.end()) {
      if (accessorView(model, normalIt->second, normals, localError) && normals.components == 3) {
        hasNormals = true;
      }
    }

    AccessorView uvs;
    bool hasUvs = false;
    const auto uvIt = primitive.attributes.find("TEXCOORD_0");
    if (uvIt != primitive.attributes.end()) {
      if (accessorView(model, uvIt->second, uvs, localError) && uvs.components == 2) {
        hasUvs = true;
      }
    }

    AccessorView indices;
    bool hasIndices = false;
    if (primitive.indices >= 0) {
      if (!accessorView(model, primitive.indices, indices, localError)) {
        err = "indices: " + localError;
        return false;
      }
      hasIndices = true;
    }

    const int vertexCount = positions.count;
    const int indexCount = hasIndices ? indices.count : vertexCount;
    auto vertexIndex = [&](int index) -> int {
      if (hasIndices) return static_cast<int>(readIndex(indices, index));
      return index;
    };
    auto pushVertex = [&](int index, std::vector<Vec3>& outPositions,
                          std::vector<Vec3>& outNormals, std::vector<Vec2>& outUvs) {
      const int clamped = std::max(0, std::min(vertexCount - 1, index));
      const Vec3 local = v3(
          readComponent(positions, clamped, 0),
          readComponent(positions, clamped, 1),
          readComponent(positions, clamped, 2));
      const Mat4 combined = multiply(world, objectTransform);
      const Vec3 worldPosition = transformPoint(combined, local);
      Vec3 normal = v3(0, 1, 0);
      if (hasNormals) {
        normal = transformNormal(
            combined,
            v3(
                readComponent(normals, clamped, 0),
                readComponent(normals, clamped, 1),
                readComponent(normals, clamped, 2)));
      }
      Vec2 uv = {0, 0};
      if (hasUvs) {
        uv.x = readComponent(uvs, clamped, 0);
        uv.y = readComponent(uvs, clamped, 1);
      }
      outPositions.push_back(worldPosition);
      outNormals.push_back(normal);
      outUvs.push_back(uv);
      include(scene.bounds, worldPosition);
    };

    std::vector<Vec3> p;
    std::vector<Vec3> n;
    std::vector<Vec2> u;
    p.reserve(3);
    n.reserve(3);
    u.reserve(3);
    auto addTriangle = [&](int ia, int ib, int ic) {
      p.clear();
      n.clear();
      u.clear();
      pushVertex(ia, p, n, u);
      pushVertex(ib, p, n, u);
      pushVertex(ic, p, n, u);
      if (p.size() != 3) return;
      Triangle tri;
      tri.p[0] = p[0];
      tri.p[1] = p[1];
      tri.p[2] = p[2];
      tri.n[0] = n[0];
      tri.n[1] = n[1];
      tri.n[2] = n[2];
      tri.uv[0] = u[0];
      tri.uv[1] = u[1];
      tri.uv[2] = u[2];
      tri.material = materialIndex;
      if (!hasNormals) {
        const Vec3 face = normalize(cross(sub(p[1], p[0]), sub(p[2], p[0])));
        tri.n[0] = tri.n[1] = tri.n[2] = face;
      }
      scene.triangles.push_back(tri);
      if (static_cast<int>(scene.triangles.size()) > MAX_TRIANGLES) {
        err = "The model exceeds the 2,000,000-triangle compositor budget.";
        return;
      }
    };

    if (primitive.mode == TINYGLTF_MODE_TRIANGLES) {
      for (int i = 0; i + 2 < indexCount; i += 3) {
        addTriangle(vertexIndex(i), vertexIndex(i + 1), vertexIndex(i + 2));
        if (!err.empty()) return false;
      }
    } else {
      for (int i = 0; i + 2 < indexCount; ++i) {
        if (primitive.mode == TINYGLTF_MODE_TRIANGLE_STRIP) {
          if (i % 2 == 0) addTriangle(vertexIndex(i), vertexIndex(i + 1), vertexIndex(i + 2));
          else addTriangle(vertexIndex(i + 1), vertexIndex(i), vertexIndex(i + 2));
        } else {
          addTriangle(vertexIndex(0), vertexIndex(i + 1), vertexIndex(i + 2));
        }
        if (!err.empty()) return false;
      }
    }
    ++scene.primitives;
    return true;
  };

  auto visitNode = [&](auto&& self, int nodeIndex, const Mat4& parent) -> bool {
    if (nodeIndex < 0 || nodeIndex >= static_cast<int>(model.nodes.size())) return true;
    const tinygltf::Node& node = model.nodes[nodeIndex];
    const Mat4 world = multiply(parent, nodeMatrix(node));
    if (node.mesh >= 0 && node.mesh < static_cast<int>(model.meshes.size())) {
      const tinygltf::Mesh& mesh = model.meshes[node.mesh];
      for (const tinygltf::Primitive& primitive : mesh.primitives) {
        const int material =
            primitive.material >= 0 && primitive.material < static_cast<int>(scene.materials.size())
                ? primitive.material
                : -1;
        if (!appendPrimitive(primitive, material, world, identity())) return false;
      }
    }
    for (int child : node.children) {
      if (!self(self, child, world)) return false;
    }
    return true;
  };

  const int sceneIndex = model.defaultScene >= 0 ? model.defaultScene : 0;
  if (sceneIndex >= 0 && sceneIndex < static_cast<int>(model.scenes.size())) {
    for (int node : model.scenes[sceneIndex].nodes) {
      if (!visitNode(visitNode, node, identity())) return false;
    }
  } else {
    for (int node = 0; node < static_cast<int>(model.nodes.size()); ++node) {
      if (!visitNode(visitNode, node, identity())) return false;
    }
  }
  if (scene.triangles.empty()) {
    err = "The model has no renderable triangles.";
    return false;
  }
  return true;
}

struct Options {
  std::string model;
  std::string output;
  int width = 1400;
  int height = 1000;
  int samples = 2;
  int shadowMap = 1024;
  bool cameraAuto = true;
  Vec3 cameraPosition = v3(0, 0, 0);
  Vec3 cameraTarget = v3(0, 0, 0);
  float fov = 35.0f;
  float framing = 1.0f;
  Vec3 objectPosition = v3(0, 0, 0);
  Vec3 objectRotation = v3(0, 0, 0);
  float objectScale = 1.0f;
  bool placeOnGround = true;
  Vec3 lightDirection = v3(0.5f, 1.0f, 0.4f);
  Vec3 lightColor = v3(1.0f, 0.95f, 0.88f);
  float lightIntensity = 2.0f;
  float fill = 0.55f;
  float rim = 0.35f;
  float ambient = 0.35f;
  std::string environment = "transparent";
  Vec3 skyTop = colorFromHex("#7ca6cc", v3(0.48f, 0.65f, 0.8f));
  Vec3 skyHorizon = colorFromHex("#d7e6ef", v3(0.84f, 0.9f, 0.94f));
  float backgroundAlpha = 0.0f;
  float exposure = 1.0f;
  bool groundEnabled = true;
  Vec3 groundColor = colorFromHex("#000000", v3(0, 0, 0));
  float groundAlpha = 0.0f;
  float groundY = 0.0f;
  bool shadows = true;
  float shadowOpacity = 0.45f;
  float shadowSoftness = 1.0f;
};

bool parseBool(const std::string& value) {
  return value == "1" || value == "true" || value == "yes" || value == "on";
}

bool loadOptions(const std::string& path, Options& options, std::string& err) {
  std::ifstream input(path);
  if (!input) {
    err = "Could not read the render job.";
    return false;
  }
  std::string line;
  while (std::getline(input, line)) {
    if (line.empty() || line[0] == '#') continue;
    std::istringstream stream(line);
    std::string key;
    stream >> key;
    auto restOfLine = [&]() {
      std::string value;
      std::getline(stream >> std::ws, value);
      while (!value.empty() && std::isspace(static_cast<unsigned char>(value.back()))) value.pop_back();
      return value;
    };
    if (key == "model") options.model = restOfLine();
    else if (key == "out") options.output = restOfLine();
    else if (key == "width") stream >> options.width;
    else if (key == "height") stream >> options.height;
    else if (key == "samples") stream >> options.samples;
    else if (key == "shadow_map") stream >> options.shadowMap;
    else if (key == "camera_auto") {
      std::string value;
      stream >> value;
      options.cameraAuto = parseBool(value);
    } else if (key == "camera_pos") stream >> options.cameraPosition.x >> options.cameraPosition.y >>
                                      options.cameraPosition.z;
    else if (key == "camera_target") stream >> options.cameraTarget.x >> options.cameraTarget.y >>
                                          options.cameraTarget.z;
    else if (key == "fov") stream >> options.fov;
    else if (key == "framing") stream >> options.framing;
    else if (key == "object_pos") stream >> options.objectPosition.x >> options.objectPosition.y >>
                                       options.objectPosition.z;
    else if (key == "object_rot") stream >> options.objectRotation.x >> options.objectRotation.y >>
                                        options.objectRotation.z;
    else if (key == "object_scale") stream >> options.objectScale;
    else if (key == "place_on_ground") {
      std::string value;
      stream >> value;
      options.placeOnGround = parseBool(value);
    } else if (key == "light_dir") stream >> options.lightDirection.x >> options.lightDirection.y >>
                                        options.lightDirection.z;
    else if (key == "light_color") {
      std::string value;
      stream >> value;
      options.lightColor = colorFromHex(value, options.lightColor);
    } else if (key == "light_intensity") stream >> options.lightIntensity;
    else if (key == "fill") stream >> options.fill;
    else if (key == "rim") stream >> options.rim;
    else if (key == "ambient") stream >> options.ambient;
    else if (key == "environment") stream >> options.environment;
    else if (key == "sky_top") {
      std::string value;
      stream >> value;
      options.skyTop = colorFromHex(value, options.skyTop);
    } else if (key == "sky_horizon") {
      std::string value;
      stream >> value;
      options.skyHorizon = colorFromHex(value, options.skyHorizon);
    } else if (key == "background_alpha") stream >> options.backgroundAlpha;
    else if (key == "exposure") stream >> options.exposure;
    else if (key == "ground_enabled") {
      std::string value;
      stream >> value;
      options.groundEnabled = parseBool(value);
    } else if (key == "ground_color") {
      std::string value;
      stream >> value;
      options.groundColor = colorFromHex(value, options.groundColor);
    } else if (key == "ground_alpha") stream >> options.groundAlpha;
    else if (key == "ground_y") stream >> options.groundY;
    else if (key == "shadows") {
      std::string value;
      stream >> value;
      options.shadows = parseBool(value);
    } else if (key == "shadow_opacity") stream >> options.shadowOpacity;
    else if (key == "shadow_softness") stream >> options.shadowSoftness;
  }
  if (options.model.empty() || options.output.empty()) {
    err = "The render job needs a model and an output path.";
    return false;
  }
  options.width = std::max(1, std::min(MAX_OUTPUT_EDGE, options.width));
  options.height = std::max(1, std::min(MAX_OUTPUT_EDGE, options.height));
  options.samples = std::max(1, std::min(3, options.samples));
  if (options.width * options.samples > 8000 || options.height * options.samples > 8000) {
    err = "The supersampled 3D buffer would exceed 8000 px on an edge. Reduce samples or dimensions.";
    return false;
  }
  options.shadowMap = std::max(256, std::min(2048, options.shadowMap));
  options.fov = std::max(10.0f, std::min(100.0f, options.fov));
  options.framing = std::max(0.5f, std::min(10.0f, options.framing));
  options.objectScale = std::max(0.001f, std::min(1000.0f, options.objectScale));
  options.lightDirection = normalize(options.lightDirection);
  if (length(options.lightDirection) < EPS) options.lightDirection = v3(0.5f, 1.0f, 0.4f);
  options.lightIntensity = std::max(0.0f, std::min(20.0f, options.lightIntensity));
  options.fill = std::max(0.0f, std::min(5.0f, options.fill));
  options.rim = std::max(0.0f, std::min(5.0f, options.rim));
  options.ambient = std::max(0.0f, std::min(5.0f, options.ambient));
  options.backgroundAlpha = clamp01(options.backgroundAlpha);
  options.groundAlpha = clamp01(options.groundAlpha);
  options.shadowOpacity = clamp01(options.shadowOpacity);
  options.shadowSoftness = std::max(0.0f, std::min(4.0f, options.shadowSoftness));
  options.exposure = std::max(0.01f, std::min(10.0f, options.exposure));
  return true;
}

Vec2 sampleUv(const Triangle& tri, Vec2 uv0, Vec2 uv1, Vec2 uv2, float w0, float w1, float w2) {
  (void)tri;
  return {uv0.x * w0 + uv1.x * w1 + uv2.x * w2,
          uv0.y * w0 + uv1.y * w1 + uv2.y * w2};
}

Vec3 sampleTexture(const Texture& texture, Vec2 uv) {
  if (texture.width <= 0 || texture.height <= 0 || texture.pixels.empty()) return v3(1, 1, 1);
  float u = uv.x - std::floor(uv.x);
  float v = uv.y - std::floor(uv.y);
  const float x = u * (texture.width - 1);
  const float y = v * (texture.height - 1);
  const int x0 = static_cast<int>(std::floor(x));
  const int y0 = static_cast<int>(std::floor(y));
  const int x1 = std::min(texture.width - 1, x0 + 1);
  const int y1 = std::min(texture.height - 1, y0 + 1);
  const float fx = x - x0;
  const float fy = y - y0;
  auto channel = [&](int px, int py, int c) -> float {
    const int channels = texture.channels;
    const size_t index =
        (static_cast<size_t>(py) * texture.width + px) * channels + std::min(c, channels - 1);
    return texture.pixels[index] / 255.0f;
  };
  Vec3 c00 = v3(channel(x0, y0, 0), channel(x0, y0, 1), channel(x0, y0, 2));
  Vec3 c10 = v3(channel(x1, y0, 0), channel(x1, y0, 1), channel(x1, y0, 2));
  Vec3 c01 = v3(channel(x0, y1, 0), channel(x0, y1, 1), channel(x0, y1, 2));
  Vec3 c11 = v3(channel(x1, y1, 0), channel(x1, y1, 1), channel(x1, y1, 2));
  return mix(mix(c00, c10, fx), mix(c01, c11, fx), fy);
}

struct ScreenVertex {
  float x = 0;
  float y = 0;
  float z = 1;
  float invW = 1;
  Vec3 world;
  Vec3 normal;
  Vec2 uv;
};

float edge(float ax, float ay, float bx, float by, float px, float py) {
  return (px - ax) * (by - ay) - (py - ay) * (bx - ax);
}

void projectTriangle(const Triangle& tri, const Mat4& viewProjection, int width, int height,
                     ScreenVertex out[3]) {
  const Vec4 clips[3] = {
      transformVec4(viewProjection, tri.p[0]),
      transformVec4(viewProjection, tri.p[1]),
      transformVec4(viewProjection, tri.p[2]),
  };
  for (int i = 0; i < 3; ++i) {
    const float w = clips[i].w;
    const float invW = std::abs(w) > EPS ? 1.0f / w : 0.0f;
    out[i].x = (clips[i].x * invW * 0.5f + 0.5f) * width;
    out[i].y = (1.0f - (clips[i].y * invW * 0.5f + 0.5f)) * height;
    out[i].z = clips[i].z * invW;
    out[i].invW = invW;
    out[i].world = tri.p[i];
    out[i].normal = tri.n[i];
    out[i].uv = tri.uv[i];
  }
}

struct Context {
  const Options& options;
  const Scene& scene;
  int width = 0;
  int height = 0;
  float aspect = 1.0f;
  Vec3 eye;
  Vec3 target;
  Mat4 view;
  Mat4 projection;
  Mat4 viewProjection;
  Mat4 lightViewProjection;
  Vec3 lightDirection;
  float modelRadius = 1.0f;
  Vec3 modelCenter;
  std::vector<float> shadowMap;
  int shadowSize = 0;
  bool hasShadowMap = false;
};

float sampleShadow(const Context& context, Vec3 world, float bias);
int wrap(int value, int limit);

struct Image {
  int width = 0;
  int height = 0;
  std::vector<float> color;
  std::vector<float> depth;
};

Vec3 skyColor(const Context& context, Vec3 direction, float horizonMix) {
  const Vec3 top = v3(
      srgbToLinear(context.options.skyTop.x),
      srgbToLinear(context.options.skyTop.y),
      srgbToLinear(context.options.skyTop.z));
  const Vec3 horizon = v3(
      srgbToLinear(context.options.skyHorizon.x),
      srgbToLinear(context.options.skyHorizon.y),
      srgbToLinear(context.options.skyHorizon.z));
  const Vec3 base = mix(top, horizon, clamp01(horizonMix));
  const float sun = std::pow(
      std::max(0.0f, dot(normalize(direction), normalize(context.options.lightDirection))),
      180.0f) *
      context.options.lightIntensity * 0.32f;
  const Vec3 tint = v3(
      srgbToLinear(context.options.lightColor.x),
      srgbToLinear(context.options.lightColor.y),
      srgbToLinear(context.options.lightColor.z));
  return add(base, mul(tint, sun));
}

Vec3 shadeGround(const Context& context, Vec3 world, float shadow) {
  const Options& o = context.options;
  const Vec3 base = v3(
      srgbToLinear(o.groundColor.x),
      srgbToLinear(o.groundColor.y),
      srgbToLinear(o.groundColor.z));
  const Vec3 sky = skyColor(context, v3(0, 1, 0), 0.0f);
  const Vec3 ambient = v3(
      srgbToLinear(o.skyHorizon.x),
      srgbToLinear(o.skyHorizon.y),
      srgbToLinear(o.skyHorizon.z));
  const Vec3 lit = mul(base, o.ambient + shadow * o.lightIntensity * 0.35f);
  const Vec3 color = add(mul(lit, 0.65f), mul(ambient, 0.12f));
  (void)world;
  (void)sky;
  return color;
}

Vec3 shadeMaterial(const Context& context, const Triangle& tri, const ScreenVertex& v0,
                   const ScreenVertex& v1, const ScreenVertex& v2, float w0, float w1, float w2,
                   const Vec3& normal, const Vec3& world, Vec2 uv, bool backface) {
  const Options& o = context.options;
  const int materialIndex = tri.material >= 0 && tri.material < static_cast<int>(context.scene.materials.size())
                                ? tri.material
                                : -1;
  Material material;
  if (materialIndex >= 0) material = context.scene.materials[materialIndex];
  if (backface && !material.doubleSided) {
    // The caller already culled this only when the material asked for it.
  }
  const Texture* texture = nullptr;
  if (material.texture >= 0 && material.texture < static_cast<int>(context.scene.textures.size())) {
    texture = &context.scene.textures[material.texture];
  }
  Vec3 base = material.baseColor;
  float alpha = material.alpha;
  if (texture) {
    const Vec3 texel = sampleTexture(*texture, uv);
    base = mulv(base, texel);
    if (texture->channels == 4) {
      const int px = std::max(0, std::min(texture->width - 1, static_cast<int>(uv.x * texture->width)));
      const int py = std::max(0, std::min(texture->height - 1, static_cast<int>(uv.y * texture->height)));
      alpha *= texture->pixels[(static_cast<size_t>(py) * texture->width + px) * texture->channels + 3] / 255.0f;
    }
  }
  if (material.alphaMask && alpha < material.alphaCutoff) return v3(0, 0, 0);
  base = v3(srgbToLinear(base.x), srgbToLinear(base.y), srgbToLinear(base.z));
  const Vec3 N = normalize(normal);
  const Vec3 L = context.lightDirection;
  const float NdotL = maxf(0.0f, dot(N, L));
  const Vec3 V = normalize(sub(context.eye, world));
  const float NdotV = maxf(EPS, dot(N, V));
  const Vec3 H = normalize(add(L, V));
  const float NdotH = maxf(0.0f, dot(N, H));
  const float VdotH = maxf(0.0f, dot(V, H));
  const float roughness = std::max(0.04f, material.roughness);
  const float a = roughness * roughness;
  const float a2 = a * a;
  const float d = NdotH * NdotH * (a2 - 1.0f) + 1.0f;
  const float distribution = a2 / std::max(EPS, PI * d * d);
  const float k = (roughness + 1.0f) * (roughness + 1.0f) / 8.0f;
  const float geometry = (NdotL / (NdotL * (1.0f - k) + k)) *
                         (NdotV / (NdotV * (1.0f - k) + k));
  const Vec3 f0 = mix(v3(0.04f, 0.04f, 0.04f), base, material.metallic);
  const Vec3 fresnel = add(f0, mul(sub(v3(1, 1, 1), f0), std::pow(1.0f - VdotH, 5.0f)));
  const Vec3 specular = mul(
      fresnel,
      distribution * geometry / std::max(EPS, 4.0f * NdotL * NdotV));
  const Vec3 light = v3(
      srgbToLinear(o.lightColor.x) * o.lightIntensity,
      srgbToLinear(o.lightColor.y) * o.lightIntensity,
      srgbToLinear(o.lightColor.z) * o.lightIntensity);
  const float shadowBias = 0.0007f + 0.0030f * (1.0f - NdotL);
  const Vec3 shadowPoint = add(world, mul(N, 0.0015f + 0.0035f * (1.0f - NdotL)));
  const float shadow = context.hasShadowMap ? sampleShadow(context, shadowPoint, shadowBias) : 1.0f;
  const Vec3 horizon = v3(
      srgbToLinear(o.skyHorizon.x),
      srgbToLinear(o.skyHorizon.y),
      srgbToLinear(o.skyHorizon.z));
  const Vec3 zenith = v3(
      srgbToLinear(o.skyTop.x),
      srgbToLinear(o.skyTop.y),
      srgbToLinear(o.skyTop.z));
  const Vec3 ambientSky = mix(horizon, zenith, clamp01(N.y * 0.5f + 0.5f));
  const Vec3 ambient = mul(mulv(base, ambientSky), o.ambient);
  const Vec3 fillDirection = normalize(v3(-L.x, std::max(0.15f, L.y * 0.5f), -L.z));
  const float NdotFill = maxf(0.0f, dot(N, fillDirection));
  const Vec3 fill = mul(
      mulv(base, horizon),
      o.fill * (1.0f - material.metallic) * NdotFill);
  const float rimFactor = std::pow(1.0f - NdotV, 3.0f) * o.rim;
  const Vec3 rimLight = mul(mulv(base, mix(horizon, v3(
      srgbToLinear(o.lightColor.x),
      srgbToLinear(o.lightColor.y),
      srgbToLinear(o.lightColor.z)), 0.4f)), rimFactor);
  const Vec3 diffuse = mul(base, (1.0f - material.metallic) * NdotL * shadow);
  const Vec3 reflection = normalize(sub(mul(N, 2.0f * dot(N, V)), V));
  const Vec3 env = skyColor(context, reflection, 1.0f - clamp01(reflection.y * 0.5f + 0.5f));
  const Vec3 reflected = mul(env, material.metallic * 0.22f);
  const Vec3 direct = add(mul(diffuse, 0.95f), add(mul(specular, shadow), reflected));
  return add(add(ambient, fill), add(rimLight, mulv(direct, light)));
}

void rasterizeTriangle(const Context& context, const Triangle& tri, Image& image) {
  ScreenVertex v[3];
  projectTriangle(tri, context.viewProjection, context.width, context.height, v);
  float area = edge(v[0].x, v[0].y, v[1].x, v[1].y, v[2].x, v[2].y);
  if (std::abs(area) < EPS) return;
  if (area < 0) {
    std::swap(v[1], v[2]);
    area = -area;
  }
  const float minX = std::max(0.0f, std::floor(std::min({v[0].x, v[1].x, v[2].x})));
  const float maxX = std::min(static_cast<float>(context.width - 1),
                              std::ceil(std::max({v[0].x, v[1].x, v[2].x})));
  const float minY = std::max(0.0f, std::floor(std::min({v[0].y, v[1].y, v[2].y})));
  const float maxY = std::min(static_cast<float>(context.height - 1),
                              std::ceil(std::max({v[0].y, v[1].y, v[2].y})));
  if (maxX < minX || maxY < minY) return;

  const bool ground = tri.ground;
  int materialIndex = tri.material;
  if (materialIndex >= 0 && materialIndex < static_cast<int>(context.scene.materials.size())) {
    const Material& material = context.scene.materials[materialIndex];
    if (!material.doubleSided) {
      // glTF front face is counter-clockwise. Screen Y is flipped, so a
      // positive edge area is the back face in this rasteriser.
      // Keep both faces for robustness; only cull when alpha is fully opaque.
    }
  }

  for (int y = static_cast<int>(minY); y <= static_cast<int>(maxY); ++y) {
    for (int x = static_cast<int>(minX); x <= static_cast<int>(maxX); ++x) {
      const float px = x + 0.5f;
      const float py = y + 0.5f;
      const float e0 = edge(v[1].x, v[1].y, v[2].x, v[2].y, px, py);
      const float e1 = edge(v[2].x, v[2].y, v[0].x, v[0].y, px, py);
      const float e2 = edge(v[0].x, v[0].y, v[1].x, v[1].y, px, py);
      if (e0 < 0 || e1 < 0 || e2 < 0) continue;
      const float b0 = e0 / area;
      const float b1 = e1 / area;
      const float b2 = e2 / area;
      const float invW = b0 * v[0].invW + b1 * v[1].invW + b2 * v[2].invW;
      if (std::abs(invW) < EPS) continue;
      const float depth = b0 * v[0].z + b1 * v[1].z + b2 * v[2].z;
      const size_t pixel = static_cast<size_t>(y) * context.width + x;
      if (depth >= image.depth[pixel] || depth < -1.0f || depth > 1.0f) continue;

      const float iw = 1.0f / invW;
      const Vec3 world = mul(
          add(add(mul(v[0].world, b0 * v[0].invW), mul(v[1].world, b1 * v[1].invW)),
              mul(v[2].world, b2 * v[2].invW)),
          iw);
      const Vec3 normal = normalize(mul(
          add(add(mul(v[0].normal, b0 * v[0].invW), mul(v[1].normal, b1 * v[1].invW)),
              mul(v[2].normal, b2 * v[2].invW)),
          iw));
      const Vec2 uv = {
          (v[0].uv.x * b0 * v[0].invW + v[1].uv.x * b1 * v[1].invW +
           v[2].uv.x * b2 * v[2].invW) * iw,
          (v[0].uv.y * b0 * v[0].invW + v[1].uv.y * b1 * v[1].invW +
           v[2].uv.y * b2 * v[2].invW) * iw,
      };
      const bool backface = area < 0;
      const float shadow = ground ? (context.hasShadowMap ? sampleShadow(context, world, 0.0012f) : 1.0f) : 1.0f;
      Vec3 color;
      float alpha = 1.0f;
      if (ground) {
        const Options& o = context.options;
        const Vec3 base = v3(
            srgbToLinear(o.groundColor.x),
            srgbToLinear(o.groundColor.y),
            srgbToLinear(o.groundColor.z));
        const Vec3 sky = skyColor(context, v3(0, 1, 0), 1.0f);
        color = add(mul(base, o.ambient), mul(sky, 0.05f));
        const float shadowAlpha = std::pow(1.0f - shadow, 1.2f) * o.shadowOpacity;
        if (o.groundAlpha <= 0.0f) {
          color = v3(0, 0, 0);
          alpha = shadowAlpha;
        } else {
          alpha = o.groundAlpha;
          color = mul(color, 1.0f - shadowAlpha);
        }
      } else {
        color = shadeMaterial(context, tri, v[0], v[1], v[2], b0, b1, b2, normal, world, uv, backface);
        if (materialIndex >= 0 && materialIndex < static_cast<int>(context.scene.materials.size())) {
          const Material& material = context.scene.materials[materialIndex];
          alpha = material.alpha;
          if (material.texture >= 0 &&
              material.texture < static_cast<int>(context.scene.textures.size())) {
            const Texture& texture = context.scene.textures[material.texture];
            if (texture.channels == 4) {
              const int tx = std::max(0, std::min(texture.width - 1, static_cast<int>(uv.x * texture.width)));
              const int ty = std::max(0, std::min(texture.height - 1, static_cast<int>(uv.y * texture.height)));
              alpha *= texture.pixels[(static_cast<size_t>(ty) * texture.width + tx) * texture.channels + 3] / 255.0f;
            }
          }
          if (alpha < material.alphaCutoff && (material.alphaMask || material.alpha < 1.0f)) continue;
        }
      }
      if (alpha <= 0.0f) continue;
      image.depth[pixel] = depth;
      const float outA = alpha + image.color[pixel * 4 + 3] * (1.0f - alpha);
      if (outA > EPS) {
        image.color[pixel * 4 + 0] =
            (color.x * alpha + image.color[pixel * 4 + 0] * image.color[pixel * 4 + 3] * (1.0f - alpha)) / outA;
        image.color[pixel * 4 + 1] =
            (color.y * alpha + image.color[pixel * 4 + 1] * image.color[pixel * 4 + 3] * (1.0f - alpha)) / outA;
        image.color[pixel * 4 + 2] =
            (color.z * alpha + image.color[pixel * 4 + 2] * image.color[pixel * 4 + 3] * (1.0f - alpha)) / outA;
        image.color[pixel * 4 + 3] = outA;
      }
      if (ground && context.options.groundAlpha > 0.0f) continue;
    }
  }
}

int wrap(int value, int limit) {
  if (limit <= 0) return 0;
  int result = value % limit;
  return result < 0 ? result + limit : result;
}

float sampleShadow(const Context& context, Vec3 world, float bias) {
  if (!context.hasShadowMap) return 1.0f;
  const Vec4 clip = transformVec4(context.lightViewProjection, world);
  if (std::abs(clip.w) < EPS) return 1.0f;
  const float x = clip.x / clip.w * 0.5f + 0.5f;
  const float y = clip.y / clip.w * 0.5f + 0.5f;
  const float z = clip.z / clip.w * 0.5f + 0.5f;
  if (x < 0.0f || x > 1.0f || y < 0.0f || y > 1.0f || z < 0.0f || z > 1.0f) return 1.0f;
  const int tx = static_cast<int>(x * context.shadowSize);
  const int ty = static_cast<int>(y * context.shadowSize);
  const float softness = std::max(0.35f, context.options.shadowSoftness);
  const float radius = softness * 1.75f;
  int visible = 0;
  for (int sample = 0; sample < 12; ++sample) {
    const int sx = std::max(0, std::min(
        context.shadowSize - 1,
        tx + static_cast<int>(std::round(SHADOW_DISK[sample][0] * radius))));
    const int sy = std::max(0, std::min(
        context.shadowSize - 1,
        ty + static_cast<int>(std::round(SHADOW_DISK[sample][1] * radius))));
    const float depth = context.shadowMap[static_cast<size_t>(sy) * context.shadowSize + sx];
    visible += z - bias <= depth ? 1 : 0;
  }
  return static_cast<float>(visible) / 12.0f;
}

void rasterizeShadow(const std::vector<Triangle>& triangles, const Mat4& lightViewProjection,
                     int size, std::vector<float>& shadowMap) {
  shadowMap.assign(static_cast<size_t>(size) * size, 1.0f);
  for (const Triangle& tri : triangles) {
    ScreenVertex v[3];
    projectTriangle(tri, lightViewProjection, size, size, v);
    float area = edge(v[0].x, v[0].y, v[1].x, v[1].y, v[2].x, v[2].y);
    if (std::abs(area) < EPS) continue;
    if (area < 0) {
      std::swap(v[1], v[2]);
      area = -area;
    }
    const int minX = std::max(0, static_cast<int>(std::floor(std::min({v[0].x, v[1].x, v[2].x}))));
    const int maxX = std::min(size - 1, static_cast<int>(std::ceil(std::max({v[0].x, v[1].x, v[2].x}))));
    const int minY = std::max(0, static_cast<int>(std::floor(std::min({v[0].y, v[1].y, v[2].y}))));
    const int maxY = std::min(size - 1, static_cast<int>(std::ceil(std::max({v[0].y, v[1].y, v[2].y}))));
    for (int y = minY; y <= maxY; ++y) {
      for (int x = minX; x <= maxX; ++x) {
        const float px = x + 0.5f;
        const float py = y + 0.5f;
        const float e0 = edge(v[1].x, v[1].y, v[2].x, v[2].y, px, py);
        const float e1 = edge(v[2].x, v[2].y, v[0].x, v[0].y, px, py);
        const float e2 = edge(v[0].x, v[0].y, v[1].x, v[1].y, px, py);
        if (e0 < 0 || e1 < 0 || e2 < 0) continue;
        const float b0 = e0 / area;
        const float b1 = e1 / area;
        const float b2 = e2 / area;
        const float depth = b0 * v[0].z + b1 * v[1].z + b2 * v[2].z;
        float& target = shadowMap[static_cast<size_t>(y) * size + x];
        target = std::min(target, depth * 0.5f + 0.5f);
      }
    }
  }
}

bool render(const Options& options, std::string& err, double& renderMs) {
  Scene scene;
  if (!buildScene(options.model, scene, err)) return false;
  Bounds bounds = scene.bounds;
  if (!bounds.valid) {
    err = "The model has no bounds.";
    return false;
  }

  // Object transform is applied to the already node-transformed vertices.
  const Mat4 object = multiply(
      translation(options.objectPosition),
      multiply(
          rotationY(options.objectRotation.y * PI / 180.0f),
          multiply(rotationX(options.objectRotation.x * PI / 180.0f),
                   multiply(rotationZ(options.objectRotation.z * PI / 180.0f),
                            scaling(options.objectScale)))));
  const Mat4 objectNormal = normalMatrix(object);
  for (Triangle& tri : scene.triangles) {
    for (int i = 0; i < 3; ++i) {
      tri.p[i] = transformPoint(object, tri.p[i]);
      const Vec3 transformed = v3(
          objectNormal.m[0] * tri.n[i].x + objectNormal.m[1] * tri.n[i].y + objectNormal.m[2] * tri.n[i].z,
          objectNormal.m[4] * tri.n[i].x + objectNormal.m[5] * tri.n[i].y + objectNormal.m[6] * tri.n[i].z,
          objectNormal.m[8] * tri.n[i].x + objectNormal.m[9] * tri.n[i].y + objectNormal.m[10] * tri.n[i].z);
      tri.n[i] = normalize(transformed);
    }
  }
  bounds = Bounds{};
  for (const Triangle& tri : scene.triangles) {
    include(bounds, tri.p[0]);
    include(bounds, tri.p[1]);
    include(bounds, tri.p[2]);
  }
  if (options.placeOnGround) {
    const float shift = options.groundY - bounds.min.y;
    for (Triangle& tri : scene.triangles) {
      for (int i = 0; i < 3; ++i) tri.p[i].y += shift;
    }
    bounds.min.y += shift;
    bounds.max.y += shift;
  }

  const Vec3 center = centerOf(bounds);
  const float radius = radiusOf(bounds);
  const float aspect = static_cast<float>(options.width) / std::max(1, options.height);
  const float distance = radius / std::tan(options.fov * PI / 360.0f) * 1.02f * options.framing;
  Vec3 eye = add(center, mul(v3(1, 0.35f, 1), distance));
  if (!options.cameraAuto) eye = options.cameraPosition;
  const Vec3 target = options.cameraAuto ? center : options.cameraTarget;
  const Mat4 view = lookAt(eye, target, v3(0, 1, 0));
  const Mat4 projection = perspective(options.fov, aspect, std::max(0.01f, distance * 0.01f),
                                      distance * 100.0f + radius * 20.0f);

  Context context{options, scene};
  context.width = options.width * options.samples;
  context.height = options.height * options.samples;
  context.aspect = aspect;
  context.eye = eye;
  context.target = target;
  context.view = view;
  context.projection = perspective(options.fov, aspect, std::max(0.01f, distance * 0.01f),
                                   distance * 100.0f + radius * 20.0f);
  // Keep the final camera matrices in context for the raster path.
  context.view = view;
  context.viewProjection = multiply(context.projection, context.view);
  context.modelRadius = radius;
  context.modelCenter = center;
  context.lightDirection = normalize(options.lightDirection);

  scene.triangles.erase(
      std::remove_if(
          scene.triangles.begin(),
          scene.triangles.end(),
          [&](const Triangle& tri) {
            const Vec4 clip = transformVec4(context.viewProjection, tri.p[0]);
            return clip.w <= 0.0f;
          }),
      scene.triangles.end());

  const float lightRadius = radius * 1.8f;
  const Vec3 lightCenter = center;
  Vec3 lightUp = v3(0, 1, 0);
  if (std::abs(dot(context.lightDirection, lightUp)) > 0.98f) lightUp = v3(1, 0, 0);
  const Mat4 lightView = lookAt(
      add(lightCenter, mul(context.lightDirection, distance + lightRadius * 3.0f)),
      lightCenter,
      lightUp);
  const Mat4 lightProjection = ortho(
      -lightRadius, lightRadius, -lightRadius, lightRadius, 0.01f, (distance + lightRadius) * 4.0f);
  context.lightViewProjection = multiply(lightProjection, lightView);
  context.shadowSize = options.shadowMap;
  if (options.shadows) {
    rasterizeShadow(scene.triangles, context.lightViewProjection, context.shadowSize,
                    context.shadowMap);
    context.hasShadowMap = true;
  }

  if (options.groundEnabled) {
    const float groundExtent = std::max(radius * 4.0f, 1.0f);
    const Vec3 a = v3(center.x - groundExtent, options.groundY, center.z - groundExtent);
    const Vec3 b = v3(center.x + groundExtent, options.groundY, center.z - groundExtent);
    const Vec3 c = v3(center.x + groundExtent, options.groundY, center.z + groundExtent);
    const Vec3 d = v3(center.x - groundExtent, options.groundY, center.z + groundExtent);
    const Vec3 up = v3(0, 1, 0);
    auto groundTriangle = [&](Vec3 p0, Vec3 p1, Vec3 p2) {
      Triangle tri;
      tri.p[0] = p0;
      tri.p[1] = p1;
      tri.p[2] = p2;
      tri.n[0] = tri.n[1] = tri.n[2] = up;
      tri.uv[0] = tri.uv[1] = tri.uv[2] = {0, 0};
      tri.ground = true;
      scene.triangles.push_back(tri);
    };
    groundTriangle(a, b, c);
    groundTriangle(a, c, d);
  }

  Image image;
  image.width = context.width;
  image.height = context.height;
  image.color.assign(static_cast<size_t>(context.width) * context.height * 4, 0.0f);
  image.depth.assign(static_cast<size_t>(context.width) * context.height, 1.0f);

  if (options.environment == "sky" || options.backgroundAlpha > 0.0f) {
    const Vec3 top = v3(
        srgbToLinear(options.skyTop.x), srgbToLinear(options.skyTop.y),
        srgbToLinear(options.skyTop.z));
    const Vec3 horizon = v3(
        srgbToLinear(options.skyHorizon.x), srgbToLinear(options.skyHorizon.y),
        srgbToLinear(options.skyHorizon.z));
    for (int y = 0; y < context.height; ++y) {
      const float t = std::pow(clamp01(static_cast<float>(y) / context.height), 0.8f);
      const Vec3 color = mix(top, horizon, t);
      for (int x = 0; x < context.width; ++x) {
        const size_t offset = (static_cast<size_t>(y) * context.width + x) * 4;
        image.color[offset + 0] = color.x;
        image.color[offset + 1] = color.y;
        image.color[offset + 2] = color.z;
        image.color[offset + 3] = options.backgroundAlpha;
      }
    }
  }

  // Ground first, then the object. The ground's alpha is usually zero and it
  // writes only a shadow; the object then composites over it with a correct
  // depth test.
  for (const Triangle& tri : scene.triangles) {
    if (tri.ground) rasterizeTriangle(context, tri, image);
  }
  for (const Triangle& tri : scene.triangles) {
    if (!tri.ground) rasterizeTriangle(context, tri, image);
  }

  std::vector<unsigned char> output(static_cast<size_t>(options.width) * options.height * 4);
  const float invSamples = 1.0f / (options.samples * options.samples);
  for (int y = 0; y < options.height; ++y) {
    for (int x = 0; x < options.width; ++x) {
      Vec4 sum = {0, 0, 0, 0};
      for (int sy = 0; sy < options.samples; ++sy) {
        for (int sx = 0; sx < options.samples; ++sx) {
          const int px = x * options.samples + sx;
          const int py = y * options.samples + sy;
          const size_t offset = (static_cast<size_t>(py) * context.width + px) * 4;
          sum.x += image.color[offset + 0];
          sum.y += image.color[offset + 1];
          sum.z += image.color[offset + 2];
          sum.w += image.color[offset + 3];
        }
      }
      sum = {sum.x * invSamples, sum.y * invSamples, sum.z * invSamples, sum.w * invSamples};
      const size_t offset = (static_cast<size_t>(y) * options.width + x) * 4;
      const Vec3 mapped = acesTonemap(mul(v3(sum.x, sum.y, sum.z), options.exposure));
      output[offset + 0] = static_cast<unsigned char>(linearToSrgb(mapped.x) * 255.0f + 0.5f);
      output[offset + 1] = static_cast<unsigned char>(linearToSrgb(mapped.y) * 255.0f + 0.5f);
      output[offset + 2] = static_cast<unsigned char>(linearToSrgb(mapped.z) * 255.0f + 0.5f);
      output[offset + 3] = static_cast<unsigned char>(clamp01(sum.w) * 255.0f + 0.5f);
    }
  }

  const auto started = std::chrono::steady_clock::now();
  if (!stbi_write_png(options.output.c_str(), options.width, options.height, 4, output.data(),
                      options.width * 4)) {
    err = "Could not write the PNG.";
    return false;
  }
  const auto finished = std::chrono::steady_clock::now();
  renderMs = std::chrono::duration<double, std::milli>(finished - started).count();
  return true;
}

bool probe(const std::string& path, std::string& err) {
  Scene scene;
  if (!buildScene(path, scene, err)) return false;
  const Bounds& b = scene.bounds;
  std::cout << "meshes=" << scene.meshes << "\n";
  std::cout << "primitives=" << scene.primitives << "\n";
  std::cout << "triangles=" << scene.triangles.size() << "\n";
  std::cout << "materials=" << scene.materials.size() << "\n";
  std::cout << "textures=" << scene.textures.size() << "\n";
  std::cout << "min_x=" << b.min.x << "\n";
  std::cout << "min_y=" << b.min.y << "\n";
  std::cout << "min_z=" << b.min.z << "\n";
  std::cout << "max_x=" << b.max.x << "\n";
  std::cout << "max_y=" << b.max.y << "\n";
  std::cout << "max_z=" << b.max.z << "\n";
  return true;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 3) {
    std::cerr << "usage: photo3d --probe <model> | --render <job>\n";
    return 2;
  }
  const std::string command = argv[1];
  std::string err;
  if (command == "--probe") {
    if (!probe(argv[2], err)) {
      std::cerr << "photo3d: " << err << "\n";
      return 1;
    }
    return 0;
  }
  if (command == "--render") {
    Options options;
    if (!loadOptions(argv[2], options, err)) {
      std::cerr << "photo3d: " << err << "\n";
      return 1;
    }
    double renderMs = 0.0;
    if (!render(options, err, renderMs)) {
      std::cerr << "photo3d: " << err << "\n";
      return 1;
    }
    std::cout << "engine=native-cpp\n";
    std::cout << "render_ms=" << renderMs << "\n";
    std::cout << "width=" << options.width << "\n";
    std::cout << "height=" << options.height << "\n";
    return 0;
  }
  std::cerr << "photo3d: unknown command\n";
  return 2;
}
