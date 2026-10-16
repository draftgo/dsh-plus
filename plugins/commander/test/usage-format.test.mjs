import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTokens } from '../client/usage-state.mjs';
test('decimal M/B units preserve missing values',()=>{for(const [v,s] of [[null,'未提供'],[undefined,'未提供'],[NaN,'未提供'],[0,'0'],[999999,'999,999'],[1000000,'1.00M'],[1234567,'1.23M'],[1000000000,'1.00B'],[12345678901,'12.35B']])assert.equal(formatTokens(v),s);});
