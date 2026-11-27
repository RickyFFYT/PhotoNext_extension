/*
 * PhotoNext FX — the native pixel and text engine.
 *
 * Two jobs live here, both deliberately below the Node layer:
 *
 *   photonext_fx --text job.txt     extruded 3D text, rendered from a coverage mask
 *   photonext_fx --effect job.txt   destructive raster effects on raw RGBA
 *
 * The text renderer does not parse fonts or tessellate outlines. The Node side
 * rasterises the text it already knows how to lay out (installed fonts, custom
 * fonts, letter spacing) into an alpha mask; this program turns that mask into a
 * signed distance field and ray-marches an extrusion of it. That keeps counters
 * in "O" and "A" correct without a triangulator, makes the bevel a distance
 * field rather than a mesh artefact, and lets any font the rest of the extension
 * can render become 3D text.
 *
 * The effects are original implementations of the operations GIMP popularised.
 * No GIMP source is copied: GIMP is GPLv3 and this product is not, so the
 * formulas are written from the published definitions (Kuwahara, Sobel, rotated
 * halftone screens, polar warps) rather than ported.
 *
 * Everything is deterministic: no GPU, no clocks in the pixels, no network.
 */

#define STB_IMAGE_IMPLEMENTATION
#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "vendor/stb_image.h"
#include "vendor/stb_image_write.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

namespace {

constexpr float PI = 3.14159265358979323846f;
constexpr float EPS = 1e-6f;
constexpr const char* ENGINE_VERSION = "1.2.0";

// ---------------------------------------------------------------------------
// Small vector / matrix helpers
// ---------------------------------------------------------------------------

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
inline Vec3 add(Vec3 a, Vec3 b) { return v3(a.x + b.x, a.y + b.y, a.z + b.z); }
inline Vec3 sub(Vec3 a, Vec3 b) { return v3(a.x - b.x, a.y - b.y, a.z - b.z); }
inline Vec3 mul(Vec3 a, float s) { return v3(a.x * s, a.y * s, a.z * s); }
inline Vec3 mulv(Vec3 a, Vec3 b) { return v3(a.x * b.x, a.y * b.y, a.z * b.z); }
inline float dot(Vec3 a, Vec3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
inline Vec3 cross(Vec3 a, Vec3 b) {
  return v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
}
inline float length(Vec3 v) { return std::sqrt(dot(v, v)); }
inline Vec3 normalize(Vec3 v) {
  const float len = length(v);
  return len > EPS ? mul(v, 1.0f / len) : v3(0, 0, 0);
}
inline Vec3 mix(Vec3 a, Vec3 b, float t) { return add(mul(a, 1.0f - t), mul(b, t)); }
inline float clamp01(float v) { return std::max(0.0f, std::min(1.0f, v)); }
inline float clampf(float v, float lo, float hi) { return std::max(lo, std::min(hi, v)); }
inline float smoothstep(float edge0, float edge1, float x) {
  const float t = clamp01((x - edge0) / (edge1 - edge0 + EPS));
  return t * t * (3.0f - 2.0f * t);
}

// A rotation matrix stored row-major. Rotation order is X, then Y, then Z.
struct Mat3 {
  float m[9] = {1, 0, 0, 0, 1, 0, 0, 0, 1};
};

Mat3 rotationXyz(float rx, float ry, float rz) {
  const float cx = std::cos(rx), sx = std::sin(rx);
  const float cy = std::cos(ry), sy = std::sin(ry);
  const float cz = std::cos(rz), sz = std::sin(rz);
  Mat3 out;
  out.m[0] = cz * cy;
  out.m[1] = cz * sy * sx - sz * cx;
  out.m[2] = cz * sy * cx + sz * sx;
  out.m[3] = sz * cy;
  out.m[4] = sz * sy * sx + cz * cx;
  out.m[5] = sz * sy * cx - cz * sx;
  out.m[6] = -sy;
  out.m[7] = cy * sx;
  out.m[8] = cy * cx;
  return out;
}

Vec3 apply(const Mat3& m, Vec3 p) {
  return v3(
      m.m[0] * p.x + m.m[1] * p.y + m.m[2] * p.z,
      m.m[3] * p.x + m.m[4] * p.y + m.m[5] * p.z,
      m.m[6] * p.x + m.m[7] * p.y + m.m[8] * p.z);
}

// Inverse of a rotation is its transpose.
Vec3 applyInverse(const Mat3& m, Vec3 p) {
  return v3(
      m.m[0] * p.x + m.m[3] * p.y + m.m[6] * p.z,
      m.m[1] * p.x + m.m[4] * p.y + m.m[7] * p.z,
      m.m[2] * p.x + m.m[5] * p.y + m.m[8] * p.z);
}

// ---------------------------------------------------------------------------
// Job files
// ---------------------------------------------------------------------------

struct Job {
  std::map<std::string, std::string> values;

  std::string text(const std::string& key, const std::string& fallback = "") const {
    auto found = values.find(key);
    return found == values.end() ? fallback : found->second;
  }

  float number(const std::string& key, float fallback) const {
    auto found = values.find(key);
    if (found == values.end() || found->second.empty()) return fallback;
    return static_cast<float>(std::atof(found->second.c_str()));
  }

  int integer(const std::string& key, int fallback) const {
    auto found = values.find(key);
    if (found == values.end() || found->second.empty()) return fallback;
    return std::atoi(found->second.c_str());
  }

  Vec3 vector(const std::string& key, Vec3 fallback) const {
    auto found = values.find(key);
    if (found == values.end()) return fallback;
    std::istringstream stream(found->second);
    Vec3 out = fallback;
    if (!(stream >> out.x >> out.y >> out.z)) return fallback;
    return out;
  }
};

bool loadJob(const std::string& path, Job& job, std::string& error) {
  std::ifstream file(path);
  if (!file) {
    error = "could not open job file " + path;
    return false;
  }
  std::string line;
  while (std::getline(file, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (line.empty() || line[0] == '#') continue;
    const size_t space = line.find(' ');
    if (space == std::string::npos) {
      job.values[line] = "";
      continue;
    }
    job.values[line.substr(0, space)] = line.substr(space + 1);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

struct Image {
  int width = 0;
  int height = 0;
  std::vector<unsigned char> pixels;  // RGBA
};

bool loadPng(const std::string& path, Image& image, std::string& error) {
  int width = 0, height = 0, channels = 0;
  unsigned char* data = stbi_load(path.c_str(), &width, &height, &channels, 4);
  if (!data) {
    error = "could not read PNG " + path + ": " + stbi_failure_reason();
    return false;
  }
  image.width = width;
  image.height = height;
  image.pixels.assign(data, data + static_cast<size_t>(width) * height * 4);
  stbi_image_free(data);
  return true;
}

bool writePng(const std::string& path, const Image& image, std::string& error) {
  if (!stbi_write_png(path.c_str(), image.width, image.height, 4, image.pixels.data(),
                      image.width * 4)) {
    error = "could not write PNG " + path;
    return false;
  }
  return true;
}

bool loadRaw(const std::string& path, int width, int height, Image& image, std::string& error) {
  const size_t expected = static_cast<size_t>(width) * height * 4;
  std::ifstream file(path, std::ios::binary);
  if (!file) {
    error = "could not open raw input " + path;
    return false;
  }
  image.width = width;
  image.height = height;
  image.pixels.resize(expected);
  file.read(reinterpret_cast<char*>(image.pixels.data()), expected);
  if (static_cast<size_t>(file.gcount()) != expected) {
    error = "raw input " + path + " did not contain " + std::to_string(expected) + " bytes";
    return false;
  }
  return true;
}

bool writeRaw(const std::string& path, const Image& image, std::string& error) {
  std::ofstream file(path, std::ios::binary);
  if (!file) {
    error = "could not write raw output " + path;
    return false;
  }
  file.write(reinterpret_cast<const char*>(image.pixels.data()), image.pixels.size());
  if (!file) {
    error = "raw output " + path + " was not written completely";
    return false;
  }
  return true;
}

Vec4 pixelAt(const Image& image, int x, int y) {
  const int cx = std::max(0, std::min(image.width - 1, x));
  const int cy = std::max(0, std::min(image.height - 1, y));
  const size_t offset = (static_cast<size_t>(cy) * image.width + cx) * 4;
  return Vec4{
      image.pixels[offset] / 255.0f,
      image.pixels[offset + 1] / 255.0f,
      image.pixels[offset + 2] / 255.0f,
      image.pixels[offset + 3] / 255.0f};
}

// Bilinear sample. Outside the image is transparent, which is what a warp or a
// lens correction should leave behind rather than a smeared edge pixel.
Vec4 sample(const Image& image, float x, float y) {
  if (x < -1.0f || y < -1.0f || x > image.width || y > image.height) return Vec4{0, 0, 0, 0};
  const int x0 = static_cast<int>(std::floor(x));
  const int y0 = static_cast<int>(std::floor(y));
  const float fx = x - x0;
  const float fy = y - y0;
  const Vec4 a = pixelAt(image, x0, y0);
  const Vec4 b = pixelAt(image, x0 + 1, y0);
  const Vec4 c = pixelAt(image, x0, y0 + 1);
  const Vec4 d = pixelAt(image, x0 + 1, y0 + 1);
  const Vec4 top = Vec4{a.x + (b.x - a.x) * fx, a.y + (b.y - a.y) * fx, a.z + (b.z - a.z) * fx,
                        a.w + (b.w - a.w) * fx};
  const Vec4 bottom = Vec4{c.x + (d.x - c.x) * fx, c.y + (d.y - c.y) * fx,
                           c.z + (d.z - c.z) * fx, c.w + (d.w - c.w) * fx};
  return Vec4{top.x + (bottom.x - top.x) * fy, top.y + (bottom.y - top.y) * fy,
              top.z + (bottom.z - top.z) * fy, top.w + (bottom.w - top.w) * fy};
}

Vec3 rgb(Vec4 value) { return v3(value.x, value.y, value.z); }
Vec4 makePixel(Vec3 color, float alpha) {
  return Vec4{clamp01(color.x), clamp01(color.y), clamp01(color.z), clamp01(alpha)};
}

void store(Image& image, int x, int y, Vec4 value) {
  const size_t offset = (static_cast<size_t>(y) * image.width + x) * 4;
  image.pixels[offset] = static_cast<unsigned char>(std::lround(clamp01(value.x) * 255.0f));
  image.pixels[offset + 1] = static_cast<unsigned char>(std::lround(clamp01(value.y) * 255.0f));
  image.pixels[offset + 2] = static_cast<unsigned char>(std::lround(clamp01(value.z) * 255.0f));
  image.pixels[offset + 3] = static_cast<unsigned char>(std::lround(clamp01(value.w) * 255.0f));
}

float luminance(Vec3 color) {
  return 0.2126f * color.x + 0.7152f * color.y + 0.0722f * color.z;
}

// ---------------------------------------------------------------------------
// Signed distance field from a text mask
// ---------------------------------------------------------------------------

struct Field {
  int width = 0;
  int height = 0;
  std::vector<float> distance;  // negative inside the glyph, pixels
};

void chamferPass(std::vector<float>& distance, int width, int height, bool forward) {
  constexpr float DIAGONAL = 1.41421356f;
  if (forward) {
    for (int y = 0; y < height; ++y) {
      for (int x = 0; x < width; ++x) {
        float value = distance[static_cast<size_t>(y) * width + x];
        if (x > 0) value = std::min(value, distance[static_cast<size_t>(y) * width + x - 1] + 1.0f);
        if (y > 0) {
          value = std::min(value, distance[static_cast<size_t>(y - 1) * width + x] + 1.0f);
          if (x > 0) {
            value = std::min(
                value, distance[static_cast<size_t>(y - 1) * width + x - 1] + DIAGONAL);
          }
          if (x + 1 < width) {
            value = std::min(
                value, distance[static_cast<size_t>(y - 1) * width + x + 1] + DIAGONAL);
          }
        }
        distance[static_cast<size_t>(y) * width + x] = value;
      }
    }
  } else {
    for (int y = height - 1; y >= 0; --y) {
      for (int x = width - 1; x >= 0; --x) {
        float value = distance[static_cast<size_t>(y) * width + x];
        if (x + 1 < width) {
          value = std::min(value, distance[static_cast<size_t>(y) * width + x + 1] + 1.0f);
        }
        if (y + 1 < height) {
          value = std::min(value, distance[static_cast<size_t>(y + 1) * width + x] + 1.0f);
          if (x + 1 < width) {
            value = std::min(
                value, distance[static_cast<size_t>(y + 1) * width + x + 1] + DIAGONAL);
          }
          if (x > 0) {
            value = std::min(
                value, distance[static_cast<size_t>(y + 1) * width + x - 1] + DIAGONAL);
          }
        }
        distance[static_cast<size_t>(y) * width + x] = value;
      }
    }
  }
}

Field buildField(const Image& mask) {
  const int width = mask.width;
  const int height = mask.height;
  const size_t count = static_cast<size_t>(width) * height;
  constexpr float FAR = 1.0e6f;
  std::vector<float> toOutside(count, FAR);
  std::vector<float> toInside(count, FAR);
  for (size_t index = 0; index < count; ++index) {
    const unsigned char alpha = mask.pixels[index * 4 + 3];
    if (alpha >= 128) {
      toInside[index] = 0.0f;
    } else {
      toOutside[index] = 0.0f;
    }
  }
  chamferPass(toOutside, width, height, true);
  chamferPass(toOutside, width, height, false);
  chamferPass(toInside, width, height, true);
  chamferPass(toInside, width, height, false);

  Field field;
  field.width = width;
  field.height = height;
  field.distance.resize(count);
  for (size_t index = 0; index < count; ++index) {
    const bool inside = mask.pixels[index * 4 + 3] >= 128;
    field.distance[index] = std::min(64.0f, inside ? -toOutside[index] : toInside[index]);
  }

  // A chamfer distance is quantised in eight directions; differentiating it for
  // the extrusion wall normal shows those directions as bands. Diffuse paint
  // hides this, but a chrome reflection magnifies it, so smooth the field with
  // two 1-2-1 passes. At mask resolution this rounds the glyph by a fraction of
  // a pixel and leaves the bevel profile intact.
  std::vector<float> blurred(count);
  for (int pass = 0; pass < 2; ++pass) {
    for (int y = 0; y < height; ++y) {
      for (int x = 0; x < width; ++x) {
        const float left = field.distance[static_cast<size_t>(y) * width + std::max(0, x - 1)];
        const float center = field.distance[static_cast<size_t>(y) * width + x];
        const float right =
            field.distance[static_cast<size_t>(y) * width + std::min(width - 1, x + 1)];
        blurred[static_cast<size_t>(y) * width + x] = (left + center * 2.0f + right) * 0.25f;
      }
    }
    for (int y = 0; y < height; ++y) {
      for (int x = 0; x < width; ++x) {
        const float up = blurred[static_cast<size_t>(std::max(0, y - 1)) * width + x];
        const float center = blurred[static_cast<size_t>(y) * width + x];
        const float down = blurred[static_cast<size_t>(std::min(height - 1, y + 1)) * width + x];
        field.distance[static_cast<size_t>(y) * width + x] = (up + center * 2.0f + down) * 0.25f;
      }
    }
  }
  return field;
}

float sampleField(const Field& field, float x, float y) {
  if (x < 0.0f || y < 0.0f || x > field.width - 1.0f || y > field.height - 1.0f) {
    return 64.0f;
  }
  const int x0 = static_cast<int>(std::floor(x));
  const int y0 = static_cast<int>(std::floor(y));
  const int x1 = std::min(field.width - 1, x0 + 1);
  const int y1 = std::min(field.height - 1, y0 + 1);
  const float fx = x - x0;
  const float fy = y - y0;
  const float a = field.distance[static_cast<size_t>(y0) * field.width + x0];
  const float b = field.distance[static_cast<size_t>(y0) * field.width + x1];
  const float c = field.distance[static_cast<size_t>(y1) * field.width + x0];
  const float d = field.distance[static_cast<size_t>(y1) * field.width + x1];
  return (a + (b - a) * fx) * (1.0f - fy) + (c + (d - c) * fx) * fy;
}

// ---------------------------------------------------------------------------
// 3D text
// ---------------------------------------------------------------------------

struct TextScene {
  Field field;
  float worldWidth = 1.0f;
  float worldHeight = 1.0f;
  float halfDepth = 0.16f;
  float bevel = 0.03f;

  Vec3 position = v3(0, 0, 0);
  Mat3 rotation;

  float fov = 35.0f;
  float yaw = 0.0f;
  float pitch = 8.0f;
  float zoom = 1.0f;

  Vec3 lightDirection = v3(0.4f, 0.8f, 1.0f);
  Vec3 lightColor = v3(1.0f, 0.95f, 0.88f);
  float intensity = 1.6f;
  float fill = 0.35f;
  float rim = 0.30f;
  float ambient = 0.30f;
  float specular = 0.5f;
  float shininess = 48.0f;
  float exposure = 1.0f;

  Vec3 faceColor = v3(0.96f, 0.77f, 0.26f);
  Vec3 sideColor = v3(0.54f, 0.35f, 0.07f);
  Vec3 bevelColor = v3(1.0f, 0.91f, 0.66f);

  bool shadowEnabled = false;
  float shadowOpacity = 0.22f;
  float shadowDistance = 0.2f;
  float shadowSoftness = 0.7f;
  Vec3 shadowColor = v3(0, 0, 0);

  int backgroundMode = 0;  // 0 transparent, 1 solid, 2 gradient
  Vec3 backgroundColor = v3(0, 0, 0);
  Vec3 backgroundTop = v3(0.09f, 0.12f, 0.18f);
  Vec3 backgroundBottom = v3(0.02f, 0.03f, 0.05f);

  // Extension beyond the original solid extrusion: a twist rotates each slice
  // of the extrusion around the text centre, a face gradient runs from the
  // bottom of the glyph box to the top, and the material modes switch between
  // the studio solid, a reflective chrome and an emissive neon edge.
  float twist = 0.0f;  // radians across the full depth
  int materialMode = 0;  // 0 solid, 1 chrome, 2 neon
  bool faceGradient = false;
  Vec3 faceTopColor = v3(1.0f, 0.88f, 0.54f);
  Vec3 faceBottomColor = v3(0.88f, 0.61f, 0.10f);

  int samples = 2;
  int maxSteps = 128;
};

float sdf2D(const TextScene& scene, Vec3 point) {
  // Twist is applied in the XY plane as a function of Z. The distance field
  // remains a valid 3D field because this is a rigid transform per slice, so
  // ray marching and finite-difference normals keep working unchanged.
  Vec3 samplePoint = point;
  if (std::fabs(scene.twist) > 1.0e-6f && scene.halfDepth > 1.0e-6f) {
    const float slice = clampf(point.z / scene.halfDepth, -1.0f, 1.0f);
    const float angle = scene.twist * 0.5f * slice;
    const float ca = std::cos(angle);
    const float sa = std::sin(angle);
    samplePoint.x = point.x * ca - point.y * sa;
    samplePoint.y = point.x * sa + point.y * ca;
  }
  const float u = samplePoint.x / scene.worldWidth + 0.5f;
  const float v = 0.5f - samplePoint.y / scene.worldHeight;
  const float px = u * scene.field.width - 0.5f;
  const float py = v * scene.field.height - 0.5f;
  return sampleField(scene.field, px, py) * (scene.worldHeight / scene.field.height);
}

float mapText(const TextScene& scene, Vec3 point) {
  const float planar = sdf2D(scene, point);
  return std::max(planar, std::fabs(point.z) - scene.halfDepth);
}

bool intersectBox(Vec3 origin, Vec3 direction, Vec3 minimum, Vec3 maximum, float& t0, float& t1) {
  t0 = -1.0e30f;
  t1 = 1.0e30f;
  const float origins[3] = {origin.x, origin.y, origin.z};
  const float directions[3] = {direction.x, direction.y, direction.z};
  const float mins[3] = {minimum.x, minimum.y, minimum.z};
  const float maxs[3] = {maximum.x, maximum.y, maximum.z};
  for (int axis = 0; axis < 3; ++axis) {
    if (std::fabs(directions[axis]) < 1.0e-8f) {
      if (origins[axis] < mins[axis] || origins[axis] > maxs[axis]) return false;
      continue;
    }
    float a = (mins[axis] - origins[axis]) / directions[axis];
    float b = (maxs[axis] - origins[axis]) / directions[axis];
    if (a > b) std::swap(a, b);
    t0 = std::max(t0, a);
    t1 = std::min(t1, b);
  }
  return t1 >= std::max(t0, 0.0f);
}

bool marchText(const TextScene& scene, Vec3 origin, Vec3 direction, float t0, float t1, float& hit) {
  float t = std::max(t0, 0.0f);
  for (int step = 0; step < scene.maxSteps; ++step) {
    const Vec3 point = add(origin, mul(direction, t));
    const float distance = mapText(scene, point);
    if (distance < 0.0012f) {
      hit = t;
      return true;
    }
    t += std::max(distance * 0.9f, 0.0008f);
    if (t > t1) break;
  }
  return false;
}

Vec3 textNormal(const TextScene& scene, Vec3 point) {
  // A wider stencil than the ray-march step: the chamfer distance field is
  // quantised in eight directions, and a chrome reflection magnifies that
  // quantisation into visible stripes on a large flat letter.
  const float e = 0.012f;
  return normalize(v3(
      mapText(scene, add(point, v3(e, 0, 0))) - mapText(scene, sub(point, v3(e, 0, 0))),
      mapText(scene, add(point, v3(0, e, 0))) - mapText(scene, sub(point, v3(0, e, 0))),
      mapText(scene, add(point, v3(0, 0, e))) - mapText(scene, sub(point, v3(0, 0, e)))));
}

bool occluded(const TextScene& scene, Vec3 origin, Vec3 direction) {
  float t = 0.008f;
  for (int step = 0; step < 64; ++step) {
    const Vec3 point = add(origin, mul(direction, t));
    const float distance = mapText(scene, point);
    if (distance < 0.002f) return true;
    t += std::max(distance * 0.9f, 0.004f);
    if (t > 4.0f) break;
  }
  return false;
}

Vec3 shadeText(const TextScene& scene, Vec3 point, Vec3 normal, Vec3 cameraLocal, Vec3 base,
               bool metallic) {
  const Vec3 light = normalize(scene.lightDirection);
  const Vec3 view = normalize(sub(cameraLocal, point));
  const float diffuse = std::max(dot(normal, light), 0.0f);
  const Vec3 fillDirection = normalize(v3(-light.x, 0.55f, light.z));
  const float fill = std::max(dot(normal, fillDirection), 0.0f) * scene.fill;
  const Vec3 halfway = normalize(add(light, view));
  const float specular =
      std::pow(std::max(dot(normal, halfway), 0.0f), scene.shininess) * scene.specular;
  const float rim = std::pow(1.0f - std::max(dot(normal, view), 0.0f), 3.0f) * scene.rim;

  // A cheap SDF ambient occlusion: concave junctions (between a letter and the
  // extrusion wall) keep less of the ambient term.
  const float occlusion = clampf(0.55f + 0.45f * (mapText(scene, add(point, mul(normal, 0.035f))) / 0.035f),
                                 0.35f, 1.0f);

  // Chrome already carries a reflected studio environment in `base`; applying
  // the full diffuse term on top would turn the reflection into flat paint.
  Vec3 lit = metallic
                 ? add(mul(base, 0.95f), mul(scene.lightColor, specular * 1.2f + rim))
                 : add(mul(base, scene.ambient + diffuse * scene.intensity + fill),
                       mul(scene.lightColor, specular + rim));
  lit = mul(lit, scene.exposure * occlusion);
  // A gentle Reinhard shoulder keeps the face colour instead of clipping the
  // red channel first and turning a warm gold into white.
  return v3(lit.x / (1.0f + 0.5f * lit.x), lit.y / (1.0f + 0.5f * lit.y),
            lit.z / (1.0f + 0.5f * lit.z));
}

struct Camera {
  Vec3 position;
  Vec3 forward;
  Vec3 right;
  Vec3 up;
  float tanHalf = 0.3f;
  float aspect = 1.0f;

  Vec3 ray(float px, float py, float width, float height, float sx, float sy) const {
    const float ndcX = (2.0f * (px + sx) / width - 1.0f) * aspect * tanHalf;
    const float ndcY = (1.0f - 2.0f * (py + sy) / height) * tanHalf;
    return normalize(add(forward, add(mul(right, ndcX), mul(up, ndcY))));
  }
};

Camera makeCamera(const TextScene& scene) {
  const float yaw = scene.yaw * PI / 180.0f;
  const float pitch = clampf(scene.pitch, -80.0f, 80.0f) * PI / 180.0f;
  const float fov = clampf(scene.fov, 10.0f, 100.0f) * PI / 180.0f;
  const float radius = 0.5f * std::sqrt(scene.worldWidth * scene.worldWidth +
                                        scene.worldHeight * scene.worldHeight +
                                        scene.halfDepth * scene.halfDepth * 4.0f);
  const float distance = (radius / std::sin(fov * 0.5f)) * std::max(0.4f, scene.zoom) * 1.12f;

  Camera camera;
  const Vec3 direction =
      v3(std::sin(yaw) * std::cos(pitch), std::sin(pitch), std::cos(yaw) * std::cos(pitch));
  camera.position = mul(direction, distance);
  camera.forward = normalize(sub(v3(0, 0, 0), camera.position));
  Vec3 worldUp = std::fabs(camera.forward.y) > 0.95f ? v3(0, 0, -1) : v3(0, 1, 0);
  camera.right = normalize(cross(camera.forward, worldUp));
  camera.up = normalize(cross(camera.right, camera.forward));
  camera.tanHalf = std::tan(fov * 0.5f);
  return camera;
}

Vec3 parseHex(const std::string& text, Vec3 fallback) {
  if (text.size() < 7 || text[0] != '#') return fallback;
  auto component = [&](size_t index) -> int {
    const std::string byte = text.substr(index, 2);
    return static_cast<int>(std::strtol(byte.c_str(), nullptr, 16));
  };
  return v3(component(1) / 255.0f, component(3) / 255.0f, component(5) / 255.0f);
}

bool renderText(const Job& job, std::string& error) {
  const std::string maskPath = job.text("mask");
  const std::string outputPath = job.text("out");
  const int width = job.integer("width", 0);
  const int height = job.integer("height", 0);
  if (maskPath.empty() || outputPath.empty() || width <= 0 || height <= 0) {
    error = "text job needs mask, out, width and height";
    return false;
  }

  Image mask;
  if (!loadPng(maskPath, mask, error)) return false;

  TextScene scene;
  scene.field = buildField(mask);
  scene.worldHeight = std::max(0.05f, job.number("world_height", 1.0f));
  scene.worldWidth =
      std::max(0.05f, job.number("world_width", scene.worldHeight * mask.width / mask.height));
  const float depth = std::max(0.0f, job.number("depth", scene.worldHeight * 0.32f));
  scene.halfDepth = std::max(0.001f, depth * 0.5f);
  scene.bevel = std::max(0.0f, job.number("bevel", scene.worldHeight * 0.03f));

  scene.position = job.vector("position", v3(0, 0, 0));
  const Vec3 rotation = job.vector("rotation", v3(0, 0, 0));
  scene.rotation = rotationXyz(rotation.x * PI / 180.0f, rotation.y * PI / 180.0f,
                               rotation.z * PI / 180.0f);

  scene.fov = job.number("camera_fov", 35.0f);
  scene.yaw = job.number("camera_yaw", 0.0f);
  scene.pitch = job.number("camera_pitch", 8.0f);
  scene.zoom = job.number("camera_zoom", 1.0f);

  scene.lightDirection = job.vector("light_dir", scene.lightDirection);
  scene.lightColor = parseHex(job.text("light_color", "#fff4e0"), scene.lightColor);
  scene.intensity = job.number("light_intensity", scene.intensity);
  scene.fill = job.number("fill", scene.fill);
  scene.rim = job.number("rim", scene.rim);
  scene.ambient = job.number("ambient", scene.ambient);
  scene.specular = job.number("specular", scene.specular);
  scene.shininess = job.number("shininess", scene.shininess);
  scene.exposure = job.number("exposure", 1.0f);

  scene.faceColor = parseHex(job.text("face", "#f5c542"), scene.faceColor);
  scene.sideColor = parseHex(job.text("side", "#8a5a12"), scene.sideColor);
  scene.bevelColor = parseHex(job.text("bevel_color", "#ffe9a8"), scene.bevelColor);
  scene.faceGradient = job.integer("face_gradient", 0) != 0;
  scene.faceTopColor = parseHex(job.text("face_top", "#ffe08a"), scene.faceTopColor);
  scene.faceBottomColor = parseHex(job.text("face_bottom", "#e09b1a"), scene.faceBottomColor);
  const std::string materialMode = job.text("material_mode", "solid");
  scene.materialMode = materialMode == "chrome" ? 1 : materialMode == "neon" ? 2 : 0;
  scene.twist = job.number("twist", 0.0f) * PI / 180.0f;

  scene.shadowEnabled = job.integer("shadow_enabled", 1) != 0;
  scene.shadowOpacity = clamp01(job.number("shadow_opacity", 0.35f));
  scene.shadowDistance = std::max(0.0f, job.number("shadow_distance", 0.35f));
  scene.shadowSoftness = clamp01(job.number("shadow_softness", 0.4f));
  scene.shadowColor = parseHex(job.text("shadow_color", "#000000"), scene.shadowColor);

  const std::string background = job.text("background", "transparent");
  scene.backgroundMode = background == "solid" ? 1 : background == "gradient" ? 2 : 0;
  scene.backgroundColor = parseHex(job.text("bg_color", "#101418"), scene.backgroundColor);
  scene.backgroundTop = parseHex(job.text("bg_top", "#18202e"), scene.backgroundTop);
  scene.backgroundBottom = parseHex(job.text("bg_bottom", "#05070a"), scene.backgroundBottom);

  scene.samples = std::max(1, std::min(3, job.integer("samples", 2)));
  scene.maxSteps = std::max(48, std::min(256, job.integer("steps", 128)));

  Image output;
  output.width = width;
  output.height = height;
  output.pixels.assign(static_cast<size_t>(width) * height * 4, 0);

  const Camera camera = makeCamera(scene);
  const Vec3 cameraLocal = applyInverse(scene.rotation, sub(camera.position, scene.position));
  const Vec3 lightLocal = normalize(applyInverse(scene.rotation, scene.lightDirection));
  const float shadowPlane = -scene.halfDepth - scene.shadowDistance;

  const Vec3 boxMin = v3(-scene.worldWidth * 0.5f, -scene.worldHeight * 0.5f, -scene.halfDepth);
  const Vec3 boxMax = v3(scene.worldWidth * 0.5f, scene.worldHeight * 0.5f, scene.halfDepth);
  const Vec3 shadowMin = v3(-scene.worldWidth * 0.8f, -scene.worldHeight * 0.8f, shadowPlane);
  const Vec3 shadowMax = v3(scene.worldWidth * 0.8f, scene.worldHeight * 0.8f, shadowPlane);

  const float sampleCount = static_cast<float>(scene.samples);
  const float sampleStep = 1.0f / sampleCount;
  const float jitter = sampleStep * 0.5f;

  for (int y = 0; y < height; ++y) {
    for (int x = 0; x < width; ++x) {
      Vec3 accumulated = v3(0, 0, 0);
      float coverage = 0.0f;
      for (int sy = 0; sy < scene.samples; ++sy) {
        for (int sx = 0; sx < scene.samples; ++sx) {
          const Vec3 worldRay =
              camera.ray(static_cast<float>(x), static_cast<float>(y),
                         static_cast<float>(width), static_cast<float>(height),
                         (sx + 0.5f) * sampleStep - jitter, (sy + 0.5f) * sampleStep - jitter);
          const Vec3 localOrigin = applyInverse(scene.rotation, sub(camera.position, scene.position));
          const Vec3 localRay = applyInverse(scene.rotation, worldRay);

          float t0 = 0.0f, t1 = 0.0f;
          float hit = 0.0f;
          if (intersectBox(localOrigin, localRay, boxMin, boxMax, t0, t1) &&
              marchText(scene, localOrigin, localRay, t0, t1, hit)) {
            const Vec3 point = add(localOrigin, mul(localRay, hit));
            Vec3 normal = textNormal(scene, point);
            const float planar = sdf2D(scene, point);
            const float cap = smoothstep(0.45f, 0.9f, std::fabs(normal.z));
            // A flat cap's finite-difference normal carries tiny horizontal
            // ripples from the distance field. They are invisible on diffuse
            // paint but a chrome reflection turns them into stripes, so use the
            // exact geometric normal once the surface is clearly a cap.
            if (cap > 0.92f) normal = v3(0.0f, 0.0f, normal.z < 0.0f ? -1.0f : 1.0f);
            Vec3 base = mix(scene.sideColor, scene.faceColor, cap);
            const bool metallic = scene.materialMode == 1;

            if (scene.faceGradient && cap > 0.001f) {
              const float t = clamp01((point.y + scene.worldHeight * 0.5f) / scene.worldHeight);
              const Vec3 gradient = mix(scene.faceBottomColor, scene.faceTopColor, t);
              base = mix(base, gradient, cap);
            }

            if (scene.materialMode == 2) {
              // Neon reads as a dark body with a hot edge, not a bright slab.
              base = mix(mul(scene.sideColor, 0.35f), mul(scene.faceColor, 0.10f), cap);
            } else if (metallic) {
              const Vec3 view = normalize(sub(cameraLocal, point));
              const Vec3 reflected = sub(view, mul(normal, 2.0f * dot(view, normal)));
              // A studio-ish vertical environment: bright sky above, a strong
              // horizon band at eye level and a darker floor. The horizon is
              // what makes the flat face read as polished metal instead of
              // near-black paint.
              const float sky = smoothstep(-0.6f, 0.45f, reflected.y);
              Vec3 environment = mix(v3(0.30f, 0.33f, 0.40f), v3(1.0f, 1.03f, 1.08f), sky);
              const float sun = std::pow(std::max(dot(reflected, normalize(scene.lightDirection)), 0.0f), 28.0f);
              environment = add(environment, mul(scene.lightColor, sun * 1.6f));
              const float horizon = std::exp(-std::fabs(reflected.y) * 10.0f);
              environment = add(environment, mul(scene.bevelColor, horizon * 0.45f));
              base = mix(environment, mul(scene.faceColor, 0.65f), 0.1f);
            }

            if (scene.bevel > 1.0e-4f && cap > 0.01f) {
              const float edge = clamp01(-planar / scene.bevel);
              const float e = 0.0015f;
              const Vec3 gradient = v3(
                  sdf2D(scene, add(point, v3(e, 0, 0))) - sdf2D(scene, sub(point, v3(e, 0, 0))),
                  sdf2D(scene, add(point, v3(0, e, 0))) - sdf2D(scene, sub(point, v3(0, e, 0))),
                  0.0f);
              Vec3 tilted = normalize(add(normalize(gradient), mul(v3(0, 0, normal.z), 0.65f)));
              normal = normalize(mix(tilted, normal, edge));
              base = mix(base, scene.bevelColor, (1.0f - edge) * cap * 0.85f);
            }

            Vec3 shaded = shadeText(scene, point, normal, cameraLocal, base, metallic);
            if (scene.materialMode == 2) {
              const float edgeWidth = std::max(scene.bevel, scene.worldHeight * 0.018f);
              const float glow = 1.0f - smoothstep(0.0f, edgeWidth * 2.2f, -planar);
              shaded = add(shaded, mul(scene.bevelColor, glow * edgeWidth * 8.0f));
            }
            accumulated = add(accumulated, shaded);
            coverage += 1.0f;
            continue;
          }

          if (!scene.shadowEnabled) continue;
          float planeT = 0.0f;
          if (!intersectBox(localOrigin, localRay, shadowMin, shadowMax, planeT, t1)) continue;
          if (planeT < 0.0f) continue;
          const Vec3 planePoint = add(localOrigin, mul(localRay, planeT));
          if (planePoint.x < -scene.worldWidth * 0.8f ||
              planePoint.x > scene.worldWidth * 0.8f ||
              planePoint.y < -scene.worldHeight * 0.8f ||
              planePoint.y > scene.worldHeight * 0.8f) {
            continue;
          }

          // Soft shadow: a small cone around the key light. The samples are
          // deterministic so a re-render of the same job is pixel-identical.
          const float soft = scene.shadowSoftness * 0.1f;
          const Vec3 offsetA = normalize(cross(lightLocal, v3(0, 1, 0)));
          const Vec3 offsetB = normalize(cross(lightLocal, offsetA));
          int blocked = 0;
          const int taps = scene.shadowSoftness > 0.02f ? 12 : 1;
          for (int tap = 0; tap < taps; ++tap) {
            const float angle = (2.0f * PI * tap) / taps;
            const Vec3 direction =
                normalize(add(lightLocal, add(mul(offsetA, std::cos(angle) * soft),
                                              mul(offsetB, std::sin(angle) * soft))));
            if (occluded(scene, planePoint, direction)) blocked += 1;
          }
          const float planeHalfW = scene.worldWidth * 0.8f;
          const float planeHalfH = scene.worldHeight * 0.8f;
          const float fadeX = smoothstep(0.0f, 0.18f, (planeHalfW - std::fabs(planePoint.x)) / planeHalfW);
          const float fadeY = smoothstep(0.0f, 0.18f, (planeHalfH - std::fabs(planePoint.y)) / planeHalfH);
          const float shadow =
              static_cast<float>(blocked) / taps * scene.shadowOpacity * fadeX * fadeY;
          if (shadow > 0.0f) {
            accumulated = add(accumulated, mul(scene.shadowColor, shadow));
            coverage += shadow;
          }
        }
      }

      const float samplesSquared = sampleCount * sampleCount;
      Vec3 color = mul(accumulated, 1.0f / samplesSquared);
      float alpha = coverage / samplesSquared;

      if (scene.backgroundMode == 1) {
        color = add(color, mul(scene.backgroundColor, 1.0f - alpha));
        alpha = 1.0f;
      } else if (scene.backgroundMode == 2) {
        const float t = height <= 1 ? 0.0f : static_cast<float>(y) / (height - 1);
        const Vec3 background = mix(scene.backgroundTop, scene.backgroundBottom, t);
        color = add(color, mul(background, 1.0f - alpha));
        alpha = 1.0f;
      } else if (alpha > 1.0e-5f) {
        color = mul(color, 1.0f / alpha);
      }

      store(output, x, y, makePixel(color, alpha));
    }
  }

  if (!writePng(outputPath, output, error)) return false;
  std::cout << "width=" << width << "\n";
  std::cout << "height=" << height << "\n";
  std::cout << "samples=" << scene.samples << "\n";
  std::cout << "rays="
            << static_cast<long long>(width) * height * scene.samples * scene.samples << "\n";
  return true;
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

Image copyOf(const Image& input) { return input; }

void boxBlurFloat(std::vector<float>& data, int width, int height, int channels, int radius) {
  if (radius <= 0) return;
  std::vector<float> temporary(data.size());
  const float scale = 1.0f / (radius * 2 + 1);
  for (int channel = 0; channel < channels; ++channel) {
    for (int y = 0; y < height; ++y) {
      float sum = 0.0f;
      for (int x = -radius; x <= radius; ++x) {
        sum += data[(static_cast<size_t>(y) * width + std::max(0, std::min(width - 1, x))) *
                        channels +
                    channel];
      }
      for (int x = 0; x < width; ++x) {
        temporary[(static_cast<size_t>(y) * width + x) * channels + channel] = sum * scale;
        const int addX = std::min(width - 1, x + radius + 1);
        const int removeX = std::max(0, x - radius);
        sum += data[(static_cast<size_t>(y) * width + addX) * channels + channel] -
               data[(static_cast<size_t>(y) * width + removeX) * channels + channel];
      }
    }
    for (int x = 0; x < width; ++x) {
      float sum = 0.0f;
      for (int y = -radius; y <= radius; ++y) {
        sum += temporary[(static_cast<size_t>(std::max(0, std::min(height - 1, y))) * width + x) *
                             channels +
                         channel];
      }
      for (int y = 0; y < height; ++y) {
        data[(static_cast<size_t>(y) * width + x) * channels + channel] = sum * scale;
        const int addY = std::min(height - 1, y + radius + 1);
        const int removeY = std::max(0, y - radius);
        sum += temporary[(static_cast<size_t>(addY) * width + x) * channels + channel] -
               temporary[(static_cast<size_t>(removeY) * width + x) * channels + channel];
      }
    }
  }
}

void effectRadialBlur(Image& image, const Job& job) {
  const float amount = job.number("amount", 30.0f);
  const int taps = std::max(4, std::min(64, job.integer("samples", 16)));
  const float cx = job.number("centerX", 0.5f) * image.width;
  const float cy = job.number("centerY", 0.5f) * image.height;
  Image source = copyOf(image);
  for (int y = 0; y < image.height; ++y) {
    for (int x = 0; x < image.width; ++x) {
      const float dx = x - cx;
      const float dy = y - cy;
      Vec4 sum{0, 0, 0, 0};
      for (int tap = 0; tap < taps; ++tap) {
        const float t = taps == 1 ? 0.0f : static_cast<float>(tap) / (taps - 1) - 0.5f;
        const Vec4 value = sample(source, x + dx * t * amount * 0.02f, y + dy * t * amount * 0.02f);
        sum.x += value.x;
        sum.y += value.y;
        sum.z += value.z;
        sum.w += value.w;
      }
      store(image, x, y, Vec4{sum.x / taps, sum.y / taps, sum.z / taps, sum.w / taps});
    }
  }
}

void effectZoomBlur(Image& image, const Job& job) {
  const float amount = job.number("amount", 0.15f);
  const int taps = std::max(4, std::min(64, job.integer("samples", 18)));
  const float cx = job.number("centerX", 0.5f) * image.width;
  const float cy = job.number("centerY", 0.5f) * image.height;
  Image source = copyOf(image);
  for (int y = 0; y < image.height; ++y) {
    for (int x = 0; x < image.width; ++x) {
      Vec4 sum{0, 0, 0, 0};
      for (int tap = 0; tap < taps; ++tap) {
        const float t = taps == 1 ? 0.0f : static_cast<float>(tap) / (taps - 1) - 0.5f;
        const float scale = 1.0f + t * amount;
        const Vec4 value = sample(source, cx + (x - cx) * scale, cy + (y - cy) * scale);
        sum.x += value.x;
        sum.y += value.y;
        sum.z += value.z;
        sum.w += value.w;
      }
      store(image, x, y, Vec4{sum.x / taps, sum.y / taps, sum.z / taps, sum.w / taps});
    }
  }
}

void effectLensDistortion(Image& image, const Job& job) {
  const float k1 = job.number("k1", -0.25f);
  const float k2 = job.number("k2", 0.0f);
  const float scale = job.number("scale", 1.0f);
  Image source = copyOf(image);
  const float cx = image.width * 0.5f;
  const float cy = image.height * 0.5f;
  const float half = std::max(1.0f, std::min(cx, cy));
  for (int y = 0; y < image.height; ++y) {
    for (int x = 0; x < image.width; ++x) {
      const float u = (x - cx) / half;
      const float v = (y - cy) / half;
      const float r2 = u * u + v * v;
      const float factor = (1.0f + k1 * r2 + k2 * r2 * r2) * scale;
      store(image, x, y, sample(source, cx + u * factor * half, cy + v * factor * half));
    }
  }
}

void effectWhirl(Image& image, const Job& job) {
  const float maxAngle = job.number("angle", 120.0f) * PI / 180.0f;
  const float radius = job.number("radius", 0.45f) * std::min(image.width, image.height);
  const float cx = job.number("centerX", 0.5f) * image.width;
  const float cy = job.number("centerY", 0.5f) * image.height;
  Image source = copyOf(image);
  for (int y = 0; y < image.height; ++y) {
    for (int x = 0; x < image.width; ++x) {
      const float dx = x - cx;
      const float dy = y - cy;
      const float distance = std::sqrt(dx * dx + dy * dy);
      if (distance >= radius) continue;
      const float t = 1.0f - distance / radius;
      const float angle = maxAngle * t * t;
      const float ca = std::cos(angle);
      const float sa = std::sin(angle);
      store(image, x, y,
            sample(source, cx + dx * ca - dy * sa, cy + dx * sa + dy * ca));
    }
  }
}

void effectMosaic(Image& image, const Job& job) {
  const int cell = std::max(2, std::min(128, job.integer("cell", 12)));
  Image source = copyOf(image);
  for (int y = 0; y < image.height; y += cell) {
    for (int x = 0; x < image.width; x += cell) {
      Vec4 sum{0, 0, 0, 0};
      int count = 0;
      const int right = std::min(image.width, x + cell);
      const int bottom = std::min(image.height, y + cell);
      for (int sy = y; sy < bottom; ++sy) {
        for (int sx = x; sx < right; ++sx) {
          const Vec4 value = pixelAt(source, sx, sy);
          sum.x += value.x;
          sum.y += value.y;
          sum.z += value.z;
          sum.w += value.w;
          count += 1;
        }
      }
      const Vec4 average = count ? Vec4{sum.x / count, sum.y / count, sum.z / count, sum.w / count}
                                 : Vec4{0, 0, 0, 0};
      for (int sy = y; sy < bottom; ++sy) {
        for (int sx = x; sx < right; ++sx) store(image, sx, sy, average);
      }
    }
  }
}

void effectOilify(Image& image, const Job& job) {
  const int radius = std::max(1, std::min(5, job.integer("radius", 2)));
  const int levels = std::max(8, std::min(64, job.integer("levels", 24)));
  Image source = copyOf(image);
  const int offsets[4][2] = {{-1, -1}, {0, -1}, {-1, 0}, {0, 0}};
  for (int y = 0; y < image.height; ++y) {
    for (int x = 0; x < image.width; ++x) {
      float bestVariance = 1.0e30f;
      Vec3 bestColor = v3(0, 0, 0);
      for (int quadrant = 0; quadrant < 4; ++quadrant) {
        const int startX = offsets[quadrant][0] * radius;
        const int startY = offsets[quadrant][1] * radius;
        double sum[3] = {0, 0, 0};
        double sumSquares = 0.0;
        int count = 0;
        for (int dy = 0; dy <= radius; ++dy) {
          for (int dx = 0; dx <= radius; ++dx) {
            const Vec4 value = pixelAt(source, x + startX + dx, y + startY + dy);
            sum[0] += value.x;
            sum[1] += value.y;
            sum[2] += value.z;
            sumSquares += value.x * value.x + value.y * value.y + value.z * value.z;
            count += 1;
          }
        }
        if (!count) continue;
        const Vec3 mean = v3(static_cast<float>(sum[0] / count),
                             static_cast<float>(sum[1] / count),
                             static_cast<float>(sum[2] / count));
        const float variance =
            static_cast<float>(sumSquares / count) - (mean.x * mean.x + mean.y * mean.y + mean.z * mean.z);
        if (variance < bestVariance) {
          bestVariance = variance;
          bestColor = mean;
        }
      }
      // Quantising the chosen mean is what turns a smoothed region into paint:
      // a flat wall becomes one of a small number of brush colours.
      const float quantise = 255.0f / levels;
      bestColor = v3(std::round(bestColor.x * 255.0f / quantise) * quantise / 255.0f,
                     std::round(bestColor.y * 255.0f / quantise) * quantise / 255.0f,
                     std::round(bestColor.z * 255.0f / quantise) * quantise / 255.0f);
      const Vec4 original = pixelAt(source, x, y);
      store(image, x, y, makePixel(bestColor, original.w));
    }
  }
}

void effectHalftone(Image& image, const Job& job) {
  const int cell = std::max(2, std::min(64, job.integer("cell", 8)));
  const float angle = job.number("angle", 15.0f) * PI / 180.0f;
  const Vec3 ink = parseHex(job.text("ink", "#000000"), v3(0, 0, 0));
  Image source = copyOf(image);
  const int cellsX = (image.width + cell - 1) / cell;
  const int cellsY = (image.height + cell - 1) / cell;
  std::vector<Vec3> averages(static_cast<size_t>(cellsX) * cellsY, v3(0, 0, 0));
  for (int cy = 0; cy < cellsY; ++cy) {
    for (int cx = 0; cx < cellsX; ++cx) {
      Vec3 sum = v3(0, 0, 0);
      int count = 0;
      for (int y = cy * cell; y < std::min(image.height, (cy + 1) * cell); ++y) {
        for (int x = cx * cell; x < std::min(image.width, (cx + 1) * cell); ++x) {
          sum = add(sum, rgb(pixelAt(source, x, y)));
          count += 1;
        }
      }
      averages[static_cast<size_t>(cy) * cellsX + cx] = count ? mul(sum, 1.0f / count) : v3(0, 0, 0);
    }
  }

  const float ca = std::cos(angle);
  const float sa = std::sin(angle);
  for (int y = 0; y < image.height; ++y) {
    for (int x = 0; x < image.width; ++x) {
      const float rx = x * ca + y * sa;
      const float ry = -x * sa + y * ca;
      const int cx = static_cast<int>(std::floor(rx / cell));
      const int cy = static_cast<int>(std::floor(ry / cell));
      const int safeX = std::max(0, std::min(cellsX - 1, cx));
      const int safeY = std::max(0, std::min(cellsY - 1, cy));
      const Vec3 average = averages[static_cast<size_t>(safeY) * cellsX + safeX];
      const float luma = luminance(average);
      const float radius = cell * 0.58f * std::sqrt(std::max(0.0f, luma));
      const float dx = rx - (cx + 0.5f) * cell;
      const float dy = ry - (cy + 0.5f) * cell;
      const float distance = std::sqrt(dx * dx + dy * dy);
      const float coverage = 1.0f - smoothstep(radius - 0.7f, radius + 0.7f, distance);
      store(image, x, y, makePixel(ink, coverage));
    }
  }
}

void effectPixelSort(Image& image, const Job& job) {
  const float threshold = job.number("threshold", 128.0f);
  const bool vertical = job.text("direction", "horizontal") == "vertical";
  const bool reverse = job.integer("reverse", 0) != 0;
  const int minimum = std::max(2, std::min(512, job.integer("minLength", 4)));
  Image source = copyOf(image);
  const int outer = vertical ? image.width : image.height;
  const int inner = vertical ? image.height : image.width;
  std::vector<Vec4> run;
  for (int line = 0; line < outer; ++line) {
    int index = 0;
    while (index < inner) {
      auto at = [&](int position) {
        return vertical ? pixelAt(source, line, position) : pixelAt(source, position, line);
      };
      if (luminance(rgb(at(index))) * 255.0f <= threshold) {
        index += 1;
        continue;
      }
      run.clear();
      while (index < inner && luminance(rgb(at(index))) * 255.0f > threshold) {
        run.push_back(at(index));
        index += 1;
      }
      if (static_cast<int>(run.size()) < minimum) continue;
      std::stable_sort(run.begin(), run.end(), [&](const Vec4& a, const Vec4& b) {
        const float la = luminance(rgb(a));
        const float lb = luminance(rgb(b));
        return reverse ? la > lb : la < lb;
      });
      const int start = index - static_cast<int>(run.size());
      for (int offset = 0; offset < static_cast<int>(run.size()); ++offset) {
        if (vertical) {
          store(image, line, start + offset, run[offset]);
        } else {
          store(image, start + offset, line, run[offset]);
        }
      }
    }
  }
}

void effectGlow(Image& image, const Job& job) {
  const float threshold = job.number("threshold", 190.0f);
  const int radius = std::max(1, std::min(80, job.integer("radius", 12)));
  const float intensity = job.number("intensity", 0.8f);
  const size_t count = static_cast<size_t>(image.width) * image.height;
  std::vector<float> bright(count * 3, 0.0f);
  for (size_t index = 0; index < count; ++index) {
    const size_t offset = index * 4;
    const Vec3 color = v3(image.pixels[offset] / 255.0f, image.pixels[offset + 1] / 255.0f,
                          image.pixels[offset + 2] / 255.0f);
    const float luma = luminance(color) * 255.0f;
    if (luma <= threshold) continue;
    const float weight = (luma - threshold) / std::max(1.0f, 255.0f - threshold);
    bright[index * 3] = color.x * weight;
    bright[index * 3 + 1] = color.y * weight;
    bright[index * 3 + 2] = color.z * weight;
  }
  const int r1 = std::max(1, radius / 3);
  const int r2 = std::max(1, (radius * 2) / 3);
  boxBlurFloat(bright, image.width, image.height, 3, r1);
  boxBlurFloat(bright, image.width, image.height, 3, r2);
  for (size_t index = 0; index < count; ++index) {
    const size_t offset = index * 4;
    const Vec3 base = v3(image.pixels[offset] / 255.0f, image.pixels[offset + 1] / 255.0f,
                         image.pixels[offset + 2] / 255.0f);
    const Vec3 glow = v3(bright[index * 3] * intensity, bright[index * 3 + 1] * intensity,
                         bright[index * 3 + 2] * intensity);
    const Vec3 screen = v3(1.0f - (1.0f - base.x) * (1.0f - clamp01(glow.x)),
                           1.0f - (1.0f - base.y) * (1.0f - clamp01(glow.y)),
                           1.0f - (1.0f - base.z) * (1.0f - clamp01(glow.z)));
    store(image, static_cast<int>(index % image.width), static_cast<int>(index / image.width),
          Vec4{screen.x, screen.y, screen.z, image.pixels[offset + 3] / 255.0f});
  }
}

void effectWave(Image& image, const Job& job) {
  const float amplitude = job.number("amplitude", 12.0f);
  const float wavelength = std::max(4.0f, job.number("wavelength", 48.0f));
  const float phase = job.number("phase", 0.0f) * PI / 180.0f;
  const std::string axis = job.text("axis", "both");
  Image source = copyOf(image);
  const float k = 2.0f * PI / wavelength;
  for (int y = 0; y < image.height; ++y) {
    for (int x = 0; x < image.width; ++x) {
      const float dx = axis == "vertical" ? 0.0f : amplitude * std::sin(k * y + phase);
      const float dy = axis == "horizontal" ? 0.0f : amplitude * std::sin(k * x + phase);
      store(image, x, y, sample(source, x + dx, y + dy));
    }
  }
}

void effectChromaticAberration(Image& image, const Job& job) {
  const float amount = job.number("amount", 6.0f);
  const float angle = job.number("angle", 0.0f) * PI / 180.0f;
  Image source = copyOf(image);
  const float dx = std::cos(angle) * amount;
  const float dy = std::sin(angle) * amount;
  for (int y = 0; y < image.height; ++y) {
    for (int x = 0; x < image.width; ++x) {
      const Vec4 center = pixelAt(source, x, y);
      const Vec4 red = sample(source, x + dx, y + dy);
      const Vec4 blue = sample(source, x - dx, y - dy);
      store(image, x, y, Vec4{red.x, center.y, blue.z, center.w});
    }
  }
}

// A deterministic 0..1 value per integer coordinate. Used by the cell-based
// effects so a re-render of the same job is pixel-identical; <random> would
// make the preview and the applied effect disagree.
float hash01(int x, int y, int seed) {
  uint32_t h = static_cast<uint32_t>(x) * 374761393u +
               static_cast<uint32_t>(y) * 668265263u +
               static_cast<uint32_t>(seed) * 2246822519u;
  h = (h ^ (h >> 13)) * 1274126177u;
  h ^= h >> 16;
  return static_cast<float>(h & 0x00ffffffu) / 16777215.0f;
}

void effectKaleidoscope(Image& image, const Job& job) {
  const int segments = std::max(3, std::min(24, job.integer("segments", 8)));
  const float rotation = job.number("angle", 0.0f) * PI / 180.0f;
  const float cx = job.number("centerX", 0.5f) * image.width;
  const float cy = job.number("centerY", 0.5f) * image.height;
  const float zoom = std::max(0.2f, std::min(3.0f, job.number("zoom", 1.0f)));
  const float wedge = 2.0f * PI / segments;
  Image source = copyOf(image);
  for (int y = 0; y < image.height; ++y) {
    for (int x = 0; x < image.width; ++x) {
      const float dx = x - cx;
      const float dy = y - cy;
      const float radius = std::sqrt(dx * dx + dy * dy);
      float angle = std::atan2(dy, dx) + rotation;
      float folded = std::fmod(angle, wedge);
      if (folded < 0.0f) folded += wedge;
      // Mirror every wedge around its centre line. A wedge is sampled from the
      // full radius of the source, which is what makes the result continuous
      // across the mirror seams instead of a stack of unrelated slices.
      folded = std::fabs(folded - wedge * 0.5f);
      const float sampleX = cx + std::cos(folded) * radius / zoom;
      const float sampleY = cy + std::sin(folded) * radius / zoom;
      store(image, x, y, sample(source, sampleX, sampleY));
    }
  }
}

void effectStainedGlass(Image& image, const Job& job) {
  const int cell = std::max(6, std::min(96, job.integer("cell", 22)));
  const float jitter = clamp01(job.number("jitter", 0.8f));
  const float edge = std::max(0.0f, std::min(10.0f, job.number("edge", 1.5f)));
  const Vec3 edgeColor = parseHex(job.text("edgeColor", "#0b0d11"), v3(0.04f, 0.05f, 0.07f));
  Image source = copyOf(image);
  for (int y = 0; y < image.height; ++y) {
    for (int x = 0; x < image.width; ++x) {
      const int gx = x / cell;
      const int gy = y / cell;
      float best = 1.0e30f;
      float second = 1.0e30f;
      float bestX = x;
      float bestY = y;
      for (int oy = -1; oy <= 1; ++oy) {
        for (int ox = -1; ox <= 1; ++ox) {
          const int sx = gx + ox;
          const int sy = gy + oy;
          const float siteX =
              (static_cast<float>(sx) + 0.5f + (hash01(sx, sy, 7) - 0.5f) * jitter * 0.92f) * cell;
          const float siteY =
              (static_cast<float>(sy) + 0.5f + (hash01(sx, sy, 11) - 0.5f) * jitter * 0.92f) * cell;
          const float dx = x - siteX;
          const float dy = y - siteY;
          const float distance = std::sqrt(dx * dx + dy * dy);
          if (distance < best) {
            second = best;
            best = distance;
            bestX = siteX;
            bestY = siteY;
          } else if (distance < second) {
            second = distance;
          }
        }
      }
      const Vec4 tint = sample(source, bestX, bestY);
      Vec3 color = rgb(tint);
      if (second - best < edge) color = edgeColor;
      store(image, x, y, makePixel(color, tint.w));
    }
  }
}

void effectDither(Image& image, const Job& job) {
  const int levels = std::max(2, std::min(8, job.integer("levels", 2)));
  const bool mono = job.text("mode", "mono") == "mono";
  const bool serpentine = job.integer("serpentine", 1) != 0;
  const int width = image.width;
  const int height = image.height;
  std::vector<float> buffer(static_cast<size_t>(width) * height * 3);
  for (size_t index = 0; index < static_cast<size_t>(width) * height; ++index) {
    buffer[index * 3] = image.pixels[index * 4] / 255.0f;
    buffer[index * 3 + 1] = image.pixels[index * 4 + 1] / 255.0f;
    buffer[index * 3 + 2] = image.pixels[index * 4 + 2] / 255.0f;
  }
  const float steps = static_cast<float>(levels - 1);
  auto quantise = [&](float value) {
    return std::round(clamp01(value) * steps) / steps;
  };
  auto spread = [&](int x, int y, int dx, int dy, float error, int channel) {
    const int nx = x + dx;
    const int ny = y + dy;
    if (nx < 0 || nx >= width || ny < 0 || ny >= height) return;
    buffer[(static_cast<size_t>(ny) * width + nx) * 3 + channel] += error;
  };
  for (int y = 0; y < height; ++y) {
    const bool reverse = serpentine && (y % 2 == 1);
    for (int step = 0; step < width; ++step) {
      const int x = reverse ? width - 1 - step : step;
      const int direction = reverse ? -1 : 1;
      const size_t offset = (static_cast<size_t>(y) * width + x) * 3;
      if (mono) {
        const float luma = 0.2126f * buffer[offset] + 0.7152f * buffer[offset + 1] +
                           0.0722f * buffer[offset + 2];
        const float quantised = quantise(luma);
        const float error = luma - quantised;
        buffer[offset] = buffer[offset + 1] = buffer[offset + 2] = quantised;
        for (int channel = 0; channel < 3; ++channel) {
          spread(x, y, direction, 0, error * 7.0f / 16.0f, channel);
          spread(x, y, -direction, 1, error * 3.0f / 16.0f, channel);
          spread(x, y, 0, 1, error * 5.0f / 16.0f, channel);
          spread(x, y, direction, 1, error * 1.0f / 16.0f, channel);
        }
      } else {
        for (int channel = 0; channel < 3; ++channel) {
          const float quantised = quantise(buffer[offset + channel]);
          const float error = buffer[offset + channel] - quantised;
          buffer[offset + channel] = quantised;
          spread(x, y, direction, 0, error * 7.0f / 16.0f, channel);
          spread(x, y, -direction, 1, error * 3.0f / 16.0f, channel);
          spread(x, y, 0, 1, error * 5.0f / 16.0f, channel);
          spread(x, y, direction, 1, error * 1.0f / 16.0f, channel);
        }
      }
    }
  }
  for (int y = 0; y < height; ++y) {
    for (int x = 0; x < width; ++x) {
      const size_t index = static_cast<size_t>(y) * width + x;
      const Vec4 original = pixelAt(image, x, y);
      store(image, x, y,
            makePixel(v3(clamp01(buffer[index * 3]), clamp01(buffer[index * 3 + 1]),
                         clamp01(buffer[index * 3 + 2])),
                      original.w));
    }
  }
}

void effectMotionBlur(Image& image, const Job& job) {
  const float distance = std::max(1.0f, std::min(200.0f, job.number("distance", 24.0f)));
  const float angle = job.number("angle", 0.0f) * PI / 180.0f;
  const int taps = std::max(4, std::min(64, job.integer("samples", 18)));
  const float dx = std::cos(angle);
  const float dy = std::sin(angle);
  Image source = copyOf(image);
  for (int y = 0; y < image.height; ++y) {
    for (int x = 0; x < image.width; ++x) {
      Vec4 sum{0, 0, 0, 0};
      for (int tap = 0; tap < taps; ++tap) {
        const float t = static_cast<float>(tap) / (taps - 1) - 0.5f;
        const Vec4 value = sample(source, x + dx * t * distance, y + dy * t * distance);
        sum.x += value.x;
        sum.y += value.y;
        sum.z += value.z;
        sum.w += value.w;
      }
      store(image, x, y, Vec4{sum.x / taps, sum.y / taps, sum.z / taps, sum.w / taps});
    }
  }
}

void effectGlitch(Image& image, const Job& job) {
  const int slices = std::max(2, std::min(64, job.integer("slices", 12)));
  const float amount = std::max(0.0f, std::min(120.0f, job.number("amount", 24.0f)));
  const float split = std::max(0.0f, std::min(60.0f, job.number("rgbSplit", 8.0f)));
  const int seed = job.integer("seed", 1);
  Image source = copyOf(image);
  const int sliceHeight = std::max(1, image.height / slices);
  for (int y = 0; y < image.height; ++y) {
    const int band = y / sliceHeight;
    const float roll = hash01(band, seed, 3);
    const float tear = hash01(band, seed, 5);
    const int shift = roll < 0.18f ? 0 : static_cast<int>(std::lround((roll * 2.0f - 1.0f) * amount));
    const int channel = static_cast<int>(std::lround((tear * 2.0f - 1.0f) * split));
    for (int x = 0; x < image.width; ++x) {
      const Vec4 center = sample(source, x + shift, y);
      const Vec4 red = sample(source, x + shift + channel, y);
      const Vec4 blue = sample(source, x + shift - channel, y);
      store(image, x, y, Vec4{red.x, center.y, blue.z, center.w});
    }
  }
}

// ---------------------------------------------------------------------------
// Painterly and material effects
// ---------------------------------------------------------------------------

void effectPencilSketch(Image& image, const Job& job) {
  const float strength = clamp01(job.number("strength", 80.0f) / 100.0f);
  const int detail = std::max(1, std::min(8, job.integer("detail", 3)));
  const float paper = clamp01(job.number("paper", 20.0f) / 100.0f);
  const bool invert = job.integer("invert", 0) != 0;
  const int seed = job.integer("seed", 11);
  const int width = image.width;
  const int height = image.height;
  const size_t count = static_cast<size_t>(width) * height;
  Image source = copyOf(image);

  std::vector<float> luma(count, 0.0f);
  for (int y = 0; y < height; ++y) {
    for (int x = 0; x < width; ++x) {
      luma[static_cast<size_t>(y) * width + x] = luminance(rgb(pixelAt(source, x, y)));
    }
  }
  std::vector<float> blurred = luma;
  boxBlurFloat(blurred, width, height, 1, detail);

  for (int y = 0; y < height; ++y) {
    for (int x = 0; x < width; ++x) {
      const size_t index = static_cast<size_t>(y) * width + x;
      const float tone = luma[index];
      const float soft = blurred[index];
      // Pencil lines live where the local mean and the pixel disagree. The
      // gain turns a small difference into a graphite edge, and the tonal term
      // keeps large dark shapes readable instead of pure white.
      const float edge = clamp01(std::fabs(tone - soft) * 7.0f * strength + std::fabs(tone - soft) * 2.0f);
      float value = 1.0f - edge;
      value *= 0.78f + 0.22f * tone;
      const float grain = hash01(x, y, seed);
      value -= paper * 0.18f * (1.0f - value) * grain;
      value = clamp01(value + (tone - value) * (1.0f - strength) * 0.35f);
      if (invert) value = 1.0f - value;
      const Vec4 original = pixelAt(source, x, y);
      store(image, x, y, Vec4{value, value, value, original.w});
    }
  }
}

void effectPosterEdges(Image& image, const Job& job) {
  const int levels = std::max(2, std::min(12, job.integer("levels", 6)));
  const float edge = std::max(0.0f, std::min(5.0f, job.number("edge", 1.5f)));
  const float saturation = std::max(0.0f, std::min(200.0f, job.number("saturation", 110.0f))) / 100.0f;
  const Vec3 ink = parseHex(job.text("edgeColor", "#000000"), v3(0, 0, 0));
  const int width = image.width;
  const int height = image.height;
  Image source = copyOf(image);
  const float quantise = static_cast<float>(levels - 1);

  auto lumaAt = [&](int x, int y) { return luminance(rgb(pixelAt(source, x, y))); };

  for (int y = 0; y < height; ++y) {
    for (int x = 0; x < width; ++x) {
      const Vec4 original = pixelAt(source, x, y);
      Vec3 colour = rgb(original);
      // Posterise each channel, then pull part of the way to its grey so a
      // comic palette stays graphic without becoming neon.
      colour = v3(std::round(colour.x * quantise) / quantise,
                  std::round(colour.y * quantise) / quantise,
                  std::round(colour.z * quantise) / quantise);
      const float grey = luminance(colour);
      colour = mix(v3(grey, grey, grey), colour, saturation);

      const float gx = -lumaAt(x - 1, y - 1) - 2.0f * lumaAt(x - 1, y) - lumaAt(x - 1, y + 1) +
                       lumaAt(x + 1, y - 1) + 2.0f * lumaAt(x + 1, y) + lumaAt(x + 1, y + 1);
      const float gy = -lumaAt(x - 1, y - 1) - 2.0f * lumaAt(x, y - 1) - lumaAt(x + 1, y - 1) +
                       lumaAt(x - 1, y + 1) + 2.0f * lumaAt(x, y + 1) + lumaAt(x + 1, y + 1);
      const float gradient = std::sqrt(gx * gx + gy * gy);
      const float amount = clamp01(gradient * edge * 0.9f);
      colour = mix(colour, ink, amount);
      store(image, x, y, makePixel(colour, original.w));
    }
  }
}

void effectWatercolor(Image& image, const Job& job) {
  const int radius = std::max(1, std::min(6, job.integer("radius", 3)));
  const int levels = std::max(6, std::min(32, job.integer("levels", 14)));
  const float edge = std::max(0.0f, std::min(3.0f, job.number("edge", 0.8f)));
  const float paper = clamp01(job.number("paper", 15.0f) / 100.0f);
  const int seed = job.integer("seed", 5);
  const int width = image.width;
  const int height = image.height;
  const size_t count = static_cast<size_t>(width) * height;
  Image source = copyOf(image);

  std::vector<float> wash(count * 4, 0.0f);
  for (int y = 0; y < height; ++y) {
    for (int x = 0; x < width; ++x) {
      const Vec4 value = pixelAt(source, x, y);
      const size_t base = (static_cast<size_t>(y) * width + x) * 4;
      wash[base] = value.x;
      wash[base + 1] = value.y;
      wash[base + 2] = value.z;
      wash[base + 3] = value.w;
    }
  }
  // Two box passes approximate a broad watercolour wash without a large
  // kernel; a Kuwahara pass at this radius would be far slower for a softer
  // result than pigment actually has.
  boxBlurFloat(wash, width, height, 4, radius);
  boxBlurFloat(wash, width, height, 4, std::max(1, radius / 2));

  const float quantise = static_cast<float>(levels - 1);
  auto washLuma = [&](int x, int y) {
    const int cx = std::max(0, std::min(width - 1, x));
    const int cy = std::max(0, std::min(height - 1, y));
    const size_t base = (static_cast<size_t>(cy) * width + cx) * 4;
    return 0.2126f * wash[base] + 0.7152f * wash[base + 1] + 0.0722f * wash[base + 2];
  };

  for (int y = 0; y < height; ++y) {
    for (int x = 0; x < width; ++x) {
      const size_t base = (static_cast<size_t>(y) * width + x) * 4;
      Vec3 colour{wash[base], wash[base + 1], wash[base + 2]};
      colour = v3(std::round(colour.x * quantise) / quantise,
                  std::round(colour.y * quantise) / quantise,
                  std::round(colour.z * quantise) / quantise);
      const float gx = -washLuma(x - 1, y - 1) - 2.0f * washLuma(x - 1, y) - washLuma(x - 1, y + 1) +
                       washLuma(x + 1, y - 1) + 2.0f * washLuma(x + 1, y) + washLuma(x + 1, y + 1);
      const float gy = -washLuma(x - 1, y - 1) - 2.0f * washLuma(x, y - 1) - washLuma(x + 1, y - 1) +
                       washLuma(x - 1, y + 1) + 2.0f * washLuma(x, y + 1) + washLuma(x + 1, y + 1);
      const float gradient = std::sqrt(gx * gx + gy * gy);
      // Pencil-and-wash convention: edges are a darker version of the local
      // pigment, not black ink, so the colour is preserved.
      colour = mul(colour, 1.0f - clamp01(gradient * edge * 1.1f) * 0.75f);
      const float grain = hash01(x, y, seed) - 0.5f;
      colour = mul(colour, 1.0f + grain * paper * 0.16f);
      store(image, x, y, makePixel(colour, pixelAt(source, x, y).w));
    }
  }
}

void effectPaperGrain(Image& image, const Job& job) {
  const float amount = clamp01(job.number("amount", 35.0f) / 100.0f);
  const float scale = std::max(1.0f, std::min(20.0f, job.number("scale", 4.0f)));
  const float fibre = clamp01(job.number("fiber", 50.0f) / 100.0f);
  const int seed = job.integer("seed", 7);
  if (amount <= 0.0f) return;
  const int width = image.width;
  const int height = image.height;
  Image source = copyOf(image);

  auto lattice = [&](int x, int y) { return hash01(x, y, seed); };
  auto valueNoise = [&](float x, float y) {
    const int x0 = static_cast<int>(std::floor(x));
    const int y0 = static_cast<int>(std::floor(y));
    const float fx = x - static_cast<float>(x0);
    const float fy = y - static_cast<float>(y0);
    const float ux = fx * fx * (3.0f - 2.0f * fx);
    const float uy = fy * fy * (3.0f - 2.0f * fy);
    const float a = lattice(x0, y0);
    const float b = lattice(x0 + 1, y0);
    const float c = lattice(x0, y0 + 1);
    const float d = lattice(x0 + 1, y0 + 1);
    return (a + (b - a) * ux) * (1.0f - uy) + (c + (d - c) * ux) * uy;
  };

  for (int y = 0; y < height; ++y) {
    for (int x = 0; x < width; ++x) {
      const Vec4 original = pixelAt(source, x, y);
      const float tooth = valueNoise(x / scale, y / scale);
      // Fibres run mostly along one axis, which is what separates paper from
      // isotropic digital noise.
      const float strands = valueNoise(x / (scale * 0.35f), y / (scale * 4.0f));
      const float grain = 0.5f + (tooth - 0.5f) * 0.8f + (strands - 0.5f) * 0.6f * fibre;
      Vec3 colour = rgb(original);
      colour = mul(colour, 1.0f + (grain - 0.5f) * amount * 0.55f);
      // A tiny warm/cool split reads as fibre rather than flat noise.
      colour.x = clamp01(colour.x + (tooth - 0.5f) * amount * 0.05f);
      colour.z = clamp01(colour.z - (tooth - 0.5f) * amount * 0.04f);
      store(image, x, y, makePixel(colour, original.w));
    }
  }
}

bool renderEffect(const Job& job, std::string& error) {
  const std::string inputPath = job.text("in");
  const std::string outputPath = job.text("out");
  const int width = job.integer("width", 0);
  const int height = job.integer("height", 0);
  if (inputPath.empty() || outputPath.empty() || width <= 0 || height <= 0) {
    error = "effect job needs in, out, width and height";
    return false;
  }
  Image image;
  if (!loadRaw(inputPath, width, height, image, error)) return false;

  const std::string effect = job.text("effect");
  if (effect == "radialBlur") {
    effectRadialBlur(image, job);
  } else if (effect == "zoomBlur") {
    effectZoomBlur(image, job);
  } else if (effect == "lensDistortion") {
    effectLensDistortion(image, job);
  } else if (effect == "whirl") {
    effectWhirl(image, job);
  } else if (effect == "mosaic") {
    effectMosaic(image, job);
  } else if (effect == "oilify") {
    effectOilify(image, job);
  } else if (effect == "halftone") {
    effectHalftone(image, job);
  } else if (effect == "pixelSort") {
    effectPixelSort(image, job);
  } else if (effect == "glow") {
    effectGlow(image, job);
  } else if (effect == "wave") {
    effectWave(image, job);
  } else if (effect == "chromaticAberration") {
    effectChromaticAberration(image, job);
  } else if (effect == "kaleidoscope") {
    effectKaleidoscope(image, job);
  } else if (effect == "stainedGlass") {
    effectStainedGlass(image, job);
  } else if (effect == "dither") {
    effectDither(image, job);
  } else if (effect == "motionBlur") {
    effectMotionBlur(image, job);
  } else if (effect == "glitch") {
    effectGlitch(image, job);
  } else if (effect == "pencilSketch") {
    effectPencilSketch(image, job);
  } else if (effect == "posterEdges") {
    effectPosterEdges(image, job);
  } else if (effect == "watercolor") {
    effectWatercolor(image, job);
  } else if (effect == "paperGrain") {
    effectPaperGrain(image, job);
  } else {
    error = "unknown effect \"" + effect + "\"";
    return false;
  }

  if (!writeRaw(outputPath, image, error)) return false;
  std::cout << "width=" << width << "\n";
  std::cout << "height=" << height << "\n";
  std::cout << "effect=" << effect << "\n";
  return true;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc >= 2 && std::string(argv[1]) == "--version") {
    std::cout << "engine_version=" << ENGINE_VERSION << "\n";
    return 0;
  }
  if (argc < 3) {
    std::cerr << "usage: photonext_fx --version | --text <job> | --effect <job>\n";
    return 2;
  }
  const std::string mode = argv[1];
  const std::string jobPath = argv[2];

  Job job;
  std::string error;
  if (!loadJob(jobPath, job, error)) {
    std::cerr << "photonext_fx: " << error << "\n";
    return 1;
  }

  const auto started = std::chrono::steady_clock::now();
  const bool ok = mode == "--text" ? renderText(job, error)
                                   : mode == "--effect" ? renderEffect(job, error) : false;
  if (!ok) {
    if (error.empty()) error = "unknown mode " + mode;
    std::cerr << "photonext_fx: " << error << "\n";
    return 1;
  }
  const auto finished = std::chrono::steady_clock::now();
  const auto micros =
      std::chrono::duration_cast<std::chrono::microseconds>(finished - started).count();
  std::cout << "render_ms=" << (micros / 1000.0) << "\n";
  return 0;
}
