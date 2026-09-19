import { describe, expect, it } from 'vitest'
import { loadHubBindHost } from '../../src/framework/config.js'

describe('Hub runtime bind host',()=>{
  it('defaults to loopback',()=>{
    expect(loadHubBindHost({})).toBe('127.0.0.1')
  })
  it('allows explicit container and hostname binds',()=>{
    expect(loadHubBindHost({HUB_BIND_HOST:'0.0.0.0'})).toBe('0.0.0.0')
    expect(loadHubBindHost({HUB_BIND_HOST:'hub-api.internal'})).toBe('hub-api.internal')
    expect(loadHubBindHost({HUB_BIND_HOST:'[::1]'})).toBe('[::1]')
  })
  it('rejects schemes, paths, whitespace and empty values',()=>{
    for(const value of ['https://0.0.0.0','host/path','bad host','/tmp/socket'])
      expect(()=>loadHubBindHost({HUB_BIND_HOST:value})).toThrow('HUB_BIND_HOST')
  })
})
