// Copyright 2026 Deno Land Inc. Apache-2.0 license.

#[test]
fn ip_predicates_match_node() {
    celld::js::Engine::init();
    let mut isolate = v8::Isolate::new(Default::default());
    v8::scope!(let handles, &mut isolate);
    let context = v8::Context::new(handles, Default::default());
    let context = &mut v8::ContextScope::new(handles, context);
    let caught = std::pin::pin!(v8::TryCatch::new(context));
    let scope = &mut caught.init();
    let source = format!(
        r#"
        const __celld = {{ __nodeStubFor: () => ({{}}) }};
        {}
        const net = __celld.__netModule;
        const cases = [
          ['127.0.0.1', 4], ['0.0.0.0', 4], ['127.00.0.1', 0],
          ['256.0.0.1', 0], ['127.0.0.1\n', 0], ['localhost', 0],
          ['::', 6], ['::1', 6], ['1:2:3:4:5:6:7:8', 6],
          ['1:2:3:4:5:6:7:8:9', 0], ['::ffff:192.0.2.1', 6],
          ['::ffff:192.00.2.1', 0], ['::ffff:192.0.2.1::', 0],
          ['fe80::1%eth0', 6], ['fe80::1%en.0', 6], ['fe80::1%a:b', 6],
          ['fe80::1%eth_0', 0], ['fe80::1%', 0], ['[::1]', 0],
          [undefined, 0], [null, 0], [123, 0],
          [new String('127.0.0.1'), 4], [['::1'], 6],
          [{{ [Symbol.toPrimitive](hint) {{ return hint === 'string' ? '127.0.0.1' : '::1'; }} }}, 4],
        ];
        for (const [value, expected] of cases) {{
          if (net.isIP(value) !== expected ||
              net.isIPv4(value) !== (expected === 4) ||
              net.isIPv6(value) !== (expected === 6)) {{
            throw new Error(`IP predicate mismatch for ${{String(value)}}`);
          }}
        }}
        for (const method of ['isIP', 'isIPv4', 'isIPv6']) {{
          let didThrow = false;
          try {{ net[method](Symbol('address')); }} catch (error) {{ didThrow = error instanceof TypeError; }}
          if (!didThrow) throw new Error(`${{method}} must reject a Symbol`);
        }}
        "#,
        include_str!("../js/node_net.js")
    );
    let source = v8::String::new(scope, &source).unwrap();
    let script = v8::Script::compile(scope, source, None).expect("valid IP predicate fixture");
    if script.run(scope).is_none() {
        let error = scope.exception().unwrap().to_rust_string_lossy(scope);
        panic!("{error}");
    }
}
