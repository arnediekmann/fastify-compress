'use strict'

const fp = require('fastify-plugin')
const zlib = require('zlib')
const pump = require('pump')
const mimedb = require('mime-db')
const isStream = require('is-stream')
const intoStream = require('into-stream')
const peek = require('peek-stream')
const Minipass = require('minipass')
const pumpify = require('pumpify')
const isGzip = require('is-gzip')
const isZip = require('is-zip')
const unZipper = require('unzipper')
const isDeflate = require('is-deflate')

function compressPlugin (fastify, opts, next) {
  fastify.decorateReply('compress', compress)

  if (opts.global !== false) {
    fastify.addHook('onSend', onSend)
  }

  const inflateIfDeflated = opts.inflateIfDeflated === true
  const threshold = typeof opts.threshold === 'number' ? opts.threshold : 1024
  const compressibleTypes = opts.customTypes instanceof RegExp ? opts.customTypes : /^text\/|\+json$|\+text$|\+xml$|octet-stream$/
  const compressStream = {
    gzip: (opts.zlib || zlib).createGzip || zlib.createGzip,
    deflate: (opts.zlib || zlib).createDeflate || zlib.createDeflate
  }
  const uncompressStream = {
    gzip: (opts.zlib || zlib).createGunzip || zlib.createGunzip,
    deflate: (opts.zlib || zlib).createInflate || zlib.createInflate
  }

  const supportedEncodings = ['deflate', 'gzip', 'identity']
  if (opts.brotli) {
    compressStream.br = opts.brotli.compressStream
    supportedEncodings.push('br')
  } else if (zlib.createBrotliCompress) {
    compressStream.br = zlib.createBrotliCompress
    supportedEncodings.push('br')
  }

  if (opts.preferredEncodings) {
    supportedEncodings.sort((a, b) => {
      return (opts.preferredEncodings.indexOf(a) > supportedEncodings.indexOf(b)) ? 1 : -1
    })
  }

  next()

  function compress (payload) {
    if (payload == null) {
      this.res.log.debug('compress: missing payload')
      this.send(new Error('Internal server error'))
      return
    }

    var stream, encoding
    var noCompress =
      // don't compress on x-no-compression header
      (this.request.headers['x-no-compression'] !== undefined) ||
      // don't compress if not one of the indiated compressible types
      (shouldCompress(this.getHeader('Content-Type') || 'application/json', compressibleTypes) === false) ||
      // don't compress on missing or identity `accept-encoding` header
      ((encoding = getEncodingHeader(supportedEncodings, this.request)) === undefined || encoding === 'identity')

    if (noCompress) {
      if (inflateIfDeflated && isStream(stream = maybeUnzip(payload, this.serialize.bind(this)))) {
        encoding === undefined
          ? this.removeHeader('Content-Encoding')
          : this.header('Content-Encoding', 'identity')
        pump(stream, payload = unzipStream(uncompressStream), onEnd.bind(this))
      }
      return this.send(payload)
    }

    if (encoding === null) {
      closeStream(payload)
      this.code(406).send(new Error('Unsupported encoding'))
      return
    }

    if (typeof payload.pipe !== 'function') {
      if (!Buffer.isBuffer(payload) && typeof payload !== 'string') {
        payload = this.serialize(payload)
      }
    }

    if (typeof payload.pipe !== 'function') {
      if (Buffer.byteLength(payload) < threshold) {
        return this.send(payload)
      }
      payload = intoStream(payload)
    }

    this
      .header('Content-Encoding', encoding)
      .removeHeader('content-length')

    stream = zipStream(compressStream, encoding)
    pump(payload, stream, onEnd.bind(this))
    this.send(stream)
  }

  function onSend (req, reply, payload, next) {
    if (payload == null) {
      reply.res.log.debug('compress: missing payload')
      return next()
    }

    var stream, encoding
    var noCompress =
      // don't compress on x-no-compression header
      (req.headers['x-no-compression'] !== undefined) ||
      // don't compress if not one of the indiated compressible types
      (shouldCompress(reply.getHeader('Content-Type') || 'application/json', compressibleTypes) === false) ||
      // don't compress on missing or identity `accept-encoding` header
      ((encoding = getEncodingHeader(supportedEncodings, req)) === undefined || encoding === 'identity')

    if (noCompress) {
      if (inflateIfDeflated && isStream(stream = maybeUnzip(payload))) {
        encoding === undefined
          ? reply.removeHeader('Content-Encoding')
          : reply.header('Content-Encoding', 'identity')
        pump(stream, payload = unzipStream(uncompressStream), onEnd.bind(reply))
      }
      return next(null, payload)
    }

    if (encoding === null) {
      closeStream(payload)
      reply.code(406)
      next(new Error('Unsupported encoding'))
      return
    }

    if (typeof payload.pipe !== 'function') {
      if (Buffer.byteLength(payload) < threshold) {
        return next()
      }
      payload = intoStream(payload)
    }

    reply
      .header('Content-Encoding', encoding)
      .removeHeader('content-length')

    stream = zipStream(compressStream, encoding)
    pump(payload, stream, onEnd.bind(reply))
    next(null, stream)
  }
}

function onEnd (err) {
  if (err) this.res.log.error(err)
}

function closeStream (payload) {
  if (typeof payload.close === 'function') {
    payload.close()
  } else if (typeof payload.destroy === 'function') {
    payload.destroy()
  } else if (typeof payload.abort === 'function') {
    payload.abort()
  }
}

function getEncodingHeader (supportedEncodings, request) {
  var header = request.headers['accept-encoding']
  if (!header) return undefined

  var acceptEncodings = header.split(',').map(a => a.trim())

  for (var i = 0; i < supportedEncodings.length; i++) {
    if (acceptEncodings.includes(supportedEncodings[i])) {
      return supportedEncodings[i]
    } else if (acceptEncodings.indexOf('*') > -1) {
      return 'gzip'
    }
  }

  return null
}

function shouldCompress (type, compressibleTypes) {
  if (compressibleTypes.test(type)) return true
  var data = mimedb[type.split(';', 1)[0].trim().toLowerCase()]
  if (data === undefined) return false
  return data.compressible
}

function isCompressed (data) {
  if (isGzip(data)) return 1
  if (isDeflate(data)) return 2
  if (isZip(data)) return 3
  return 0
}

function maybeUnzip (payload, serialize) {
  if (isStream(payload)) return payload

  var buf = payload; var result = payload

  if (ArrayBuffer.isView(payload)) {
    // Cast non-Buffer DataViews into a Buffer
    buf = result = Buffer.from(
      payload.buffer,
      payload.byteOffset,
      payload.byteLength
    )
  } else if (serialize && typeof payload !== 'string') {
    buf = result = serialize(payload)
  }

  // handle case where serialize doesn't return a string or Buffer
  if (!Buffer.isBuffer(buf)) return result
  if (isCompressed(buf) === 0) return result
  return intoStream(result)
}

function zipStream (deflate, encoding) {
  return peek({ newline: false, maxBuffer: 10 }, function (data, swap) {
    switch (isCompressed(data)) {
      case 1: return swap(null, new Minipass())
      case 2: return swap(null, new Minipass())
    }
    return swap(null, deflate[encoding]())
  })
}

function unzipStream (inflate, maxRecursion) {
  if (!(maxRecursion >= 0)) maxRecursion = 3
  return peek({ newline: false, maxBuffer: 10 }, function (data, swap) {
    if (maxRecursion < 0) return swap(new Error('Maximum recursion reached'))
    switch (isCompressed(data)) {
      case 1: return swap(null, pumpify(inflate.gzip(), unzipStream(inflate, maxRecursion - 1)))
      case 2: return swap(null, pumpify(inflate.deflate(), unzipStream(inflate, maxRecursion - 1)))
      case 3: return swap(null, pumpify(unZipper.ParseOne(), unzipStream(inflate, maxRecursion - 1)))
    }
    return swap(null, new Minipass())
  })
}

module.exports = fp(compressPlugin, {
  fastify: '>=1.3.0',
  name: 'fastify-compress'
})
